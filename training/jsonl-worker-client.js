const { spawn } = require('child_process');
const crypto = require('crypto');
const { TrainingContractError } = require('./errors');

class JsonlWorkerClient {
    constructor(options = {}) {
        if (typeof options.command !== 'string' || !options.command.trim()) {
            throw new TrainingContractError('JSONL worker requires a command');
        }
        this.command = options.command;
        this.args = Array.isArray(options.args) ? options.args.map(String) : [];
        this.cwd = options.cwd || process.cwd();
        this.env = { ...process.env, ...(options.env || {}) };
        this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : 60 * 60 * 1000;
        this.maxLineBytes = Number.isInteger(options.maxLineBytes) && options.maxLineBytes > 0
            ? options.maxLineBytes
            : 16 * 1024 * 1024;
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
            pid: this.process ? this.process.pid : null,
            pending: this.pending.size,
            stderr: this.stderr,
        };
    }

    async start() {
        if (this.closed) throw new Error('Training worker client is closed');
        if (this.startPromise) return await this.startPromise;

        this.startPromise = new Promise((resolve, reject) => {
            const child = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: this.env,
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
                    `Training worker exited (code=${code}, signal=${signal || 'none'})${detail}`
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
                this._protocolFailure(new Error(
                    'Training worker response exceeded the line-size limit'
                ));
                return;
            }
            this._handleLine(line);
        }
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
            this._protocolFailure(new Error('Training worker response exceeded the line-size limit'));
        }
    }

    _handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this._protocolFailure(new Error('Training worker emitted invalid JSON on stdout'));
            return;
        }
        if (!message || typeof message.id !== 'string') {
            this._protocolFailure(new Error('Training worker response is missing an id'));
            return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
            const detail = typeof message.error === 'string'
                ? message.error
                : (message.error.message || JSON.stringify(message.error));
            pending.reject(new Error(`Training worker error: ${detail}`));
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

    async request(operation, payload) {
        if (typeof operation !== 'string' || !operation) {
            throw new TrainingContractError('Training worker operation must be a non-empty string');
        }
        await this.start();
        if (!this.process || !this.process.stdin.writable) {
            throw new Error('Training worker stdin is unavailable');
        }

        const id = crypto.randomUUID();
        const line = `${JSON.stringify({ id, operation, ...payload })}\n`;
        if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
            throw new Error('Training worker request exceeded the line-size limit');
        }

        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Training worker request timed out: ${operation}`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });

        try {
            await new Promise((resolve, reject) => {
                this.process.stdin.write(line, 'utf8', (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        } catch (error) {
            const pending = this.pending.get(id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(error);
            }
            return await response;
        }

        return await response;
    }

    async dispose() {
        this.closed = true;
        this._failAll(new Error('Training worker disposed'));
        if (!this.process) return;
        const child = this.process;
        this.process = null;
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            child.once('exit', finish);
            child.stdin.end();
            if (!child.killed) child.kill();
            const timer = setTimeout(finish, 5000);
        });
    }
}

module.exports = JsonlWorkerClient;
