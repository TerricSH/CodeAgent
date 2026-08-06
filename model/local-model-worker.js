const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function requireDirectory(directory, label) {
    let stat;
    try { stat = fs.statSync(directory); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
        throw new Error(`${label} directory does not exist: ${directory}`);
    }
}

class LocalModelWorker {
    constructor(config = {}) {
        this.command = config.pythonCommand || 'python';
        this.workerPath = config.workerPath;
        this.embeddingPath = config.embeddingPath;
        this.rerankPath = config.rerankPath;
        this.device = config.device || 'cpu';
        this.batchSize = Number.isInteger(config.batchSize) && config.batchSize > 0
            ? config.batchSize
            : 32;
        this.timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
            ? config.timeoutMs
            : 10 * 60 * 1000;
        this.maxLineBytes = 64 * 1024 * 1024;
        this.process = null;
        this.pending = new Map();
        this.buffer = '';
        this.stderr = '';
        this.startPromise = null;
        this.closed = false;
    }

    status() {
        return {
            running: Boolean(this.process && !this.process.killed),
            pid: this.process?.pid || null,
            pending: this.pending.size,
            device: this.device,
            stderr: this.stderr,
        };
    }

    _validateFiles() {
        if (!this.workerPath || !fs.existsSync(this.workerPath)) {
            throw new Error(`Local RAG worker does not exist: ${this.workerPath || '(not configured)'}`);
        }
        requireDirectory(this.embeddingPath, 'Local embedding model');
        requireDirectory(this.rerankPath, 'Local rerank model');
    }

    _buildEnvironment() {
        const environment = { ...process.env };
        for (const name of [
            'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
            'http_proxy', 'https_proxy', 'all_proxy',
        ]) {
            delete environment[name];
        }
        return {
            ...environment,
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            HF_DATASETS_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
            DO_NOT_TRACK: '1',
            NO_PROXY: '*',
            no_proxy: '*',
            PYTHONUNBUFFERED: '1',
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
        };
    }

    async start() {
        if (this.closed) throw new Error('Local RAG model worker is closed');
        if (this.startPromise) return await this.startPromise;
        this._validateFiles();

        this.startPromise = new Promise((resolve, reject) => {
            const child = spawn(this.command, [
                this.workerPath,
                '--embedding-model', this.embeddingPath,
                '--rerank-model', this.rerankPath,
                '--device', this.device,
                '--batch-size', String(this.batchSize),
            ], {
                cwd: process.cwd(),
                env: this._buildEnvironment(),
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.process = child;
            child.once('spawn', resolve);
            child.once('error', (error) => {
                this.process = null;
                this.startPromise = null;
                this._failAll(error);
                reject(error);
            });
            child.on('exit', (code, signal) => {
                const detail = this.stderr ? `: ${this.stderr}` : '';
                this._failAll(new Error(
                    `Local RAG model worker exited (code=${code}, signal=${signal || 'none'})${detail}`
                ));
                this.process = null;
                this.startPromise = null;
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this._consume(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024);
            });
        });
        return await this.startPromise;
    }

    _consume(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
                this._protocolFailure(new Error('Local RAG worker response exceeded the line-size limit'));
                return;
            }
            this._handleLine(line);
        }
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
            this._protocolFailure(new Error('Local RAG worker response exceeded the line-size limit'));
        }
    }

    _handleLine(line) {
        let message;
        try { message = JSON.parse(line); } catch {
            this._protocolFailure(new Error('Local RAG worker emitted invalid JSON on stdout'));
            return;
        }
        if (!message || typeof message.id !== 'string') {
            this._protocolFailure(new Error('Local RAG worker response is missing an id'));
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
            const detail = typeof message.error === 'string'
                ? message.error
                : message.error.message || JSON.stringify(message.error);
            const traceback = typeof message.error?.traceback === 'string'
                ? `\n${message.error.traceback}`
                : '';
            pending.reject(new Error(`Local RAG worker error: ${detail}${traceback}`));
            return;
        }
        pending.resolve(message.result);
    }

    _protocolFailure(error) {
        this._failAll(error);
        if (this.process && !this.process.killed) this.process.kill();
    }

    _failAll(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    async request(operation, payload = {}) {
        await this.start();
        if (!this.process || !this.process.stdin.writable) {
            throw new Error('Local RAG worker stdin is unavailable');
        }
        const id = crypto.randomUUID();
        const line = `${JSON.stringify({ id, operation, ...payload })}\n`;
        if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
            throw new Error('Local RAG worker request exceeded the line-size limit');
        }
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Local RAG worker request timed out: ${operation}`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        try {
            await new Promise((resolve, reject) => {
                this.process.stdin.write(line, 'utf8', (error) => error ? reject(error) : resolve());
            });
        } catch (error) {
            const pending = this.pending.get(id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(error);
            }
        }
        return await response;
    }

    async dispose() {
        this.closed = true;
        this._failAll(new Error('Local RAG worker disposed'));
        if (!this.process) return;
        const child = this.process;
        this.process = null;
        await new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve();
            };
            child.once('exit', finish);
            child.stdin.end();
            if (!child.killed) child.kill();
            timer = setTimeout(finish, 5000);
        });
    }
}

module.exports = LocalModelWorker;
