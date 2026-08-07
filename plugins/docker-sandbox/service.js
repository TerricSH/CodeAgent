const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DockerClient } = require('../../sandbox/docker-client');
const {
    normalizeSandboxConfig,
    sessionKey,
    clampTimeout,
    buildRunArgs,
} = require('../../sandbox/policy');

const STATE_VERSION = 3;

function cleanResult(result) {
    return {
        ok: result.exitCode === 0 && !result.timedOut && !result.error,
        exitCode: result.exitCode,
        signal: result.signal || null,
        timedOut: Boolean(result.timedOut),
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        truncated: Boolean(result.truncated),
        error: result.error || null,
        errorCode: result.errorCode || null,
        durationMs: result.durationMs,
    };
}

function pathIsInside(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function ensureContainedDirectory(root, candidate, label = 'Sandbox directory') {
    fs.mkdirSync(root, { recursive: true });
    const realRoot = fs.realpathSync(path.resolve(root));
    fs.mkdirSync(candidate, { recursive: true });
    const realCandidate = fs.realpathSync(path.resolve(candidate));
    if (!pathIsInside(realRoot, realCandidate)) {
        throw new Error(`${label} escaped its configured root`);
    }
    return realCandidate;
}

class DockerSandboxService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.session = sessionKey(this.sessionId);
        this.config = normalizeSandboxConfig(config);
        this.client = dependencies.client || new DockerClient({ command: this.config.command });
        this.sessionRoot = path.join(this.config.sandboxRoot, this.session);
        this.workspace = path.join(this.sessionRoot, 'workspace');
        this.executions = 0;
        this.dirty = false;
        this._queue = Promise.resolve();
        this._activeContainers = new Set();
    }

    _ensureWorkspace() {
        return ensureContainedDirectory(this.config.sandboxRoot, this.workspace, 'Sandbox workspace');
    }

    _serialize(task) {
        const next = this._queue.then(task, task);
        this._queue = next.catch(() => {});
        return next;
    }

    async status() {
        const version = await this.client.version({ timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
        if (version.error || version.exitCode !== 0) {
            return {
                available: false,
                imageReady: false,
                image: this.config.image,
                workspace: this.workspace,
                error: version.error || version.stderr || 'Docker Engine is unavailable',
            };
        }
        const image = await this.client.inspectImage(this.config.image, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        });
        return {
            available: true,
            version: (version.stdout || '').trim(),
            imageReady: image.exitCode === 0 && !image.error,
            image: this.config.image,
            imageId: image.exitCode === 0 ? (image.stdout || '').trim() : null,
            workspace: this.workspace,
            network: this.config.network,
        };
    }

    execute(args = {}) {
        return this._serialize(async () => {
            const command = typeof args.command === 'string' ? args.command.trim() : '';
            if (!command) throw new Error('command is required');
            if (command.length > 32768) throw new Error('command exceeds the 32768 character limit');
            const workspace = this._ensureWorkspace();
            const containerName = `codeagent-sbx-${this.session}-${crypto.randomUUID().slice(0, 8)}`;
            const dockerArgs = buildRunArgs({
                config: this.config,
                containerName,
                session: this.session,
                workspace,
                command,
            });

            this._activeContainers.add(containerName);
            let result;
            try {
                result = await this.client.run(dockerArgs, {
                    timeoutMs: clampTimeout(args.timeoutMs, this.config),
                    maxOutputBytes: this.config.maxOutputBytes,
                });
            } finally {
                this._activeContainers.delete(containerName);
            }
            if (result.timedOut) {
                await this.client.removeContainer(containerName, {
                    timeoutMs: 5000,
                    maxOutputBytes: 64 * 1024,
                });
            }
            this.executions += 1;
            this.dirty = true;
            return { ...cleanResult(result), execution: this.executions };
        });
    }

    reset() {
        return this._serialize(async () => {
            const root = path.resolve(this.config.sandboxRoot);
            const sessionRoot = path.resolve(this.sessionRoot);
            if (!pathIsInside(root, sessionRoot) || sessionRoot === root) {
                throw new Error('Refusing to reset a workspace outside the sandbox root');
            }
            fs.rmSync(sessionRoot, { recursive: true, force: true });
            this.executions = 0;
            this.dirty = true;
            return { reset: true, workspace: this.workspace };
        });
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || !envelope.data || ![1, 2, STATE_VERSION].includes(envelope.version)) {
            throw new Error('Invalid docker-sandbox state envelope');
        }
        this.executions = Number.isInteger(envelope.data.executions) ? envelope.data.executions : 0;
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            name: 'docker-sandbox',
            version: STATE_VERSION,
            data: { session: this.session, executions: this.executions },
        });
    }

    async dispose() {
        const names = [...this._activeContainers];
        await Promise.all(names.map(name => this.client.removeContainer(name, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        })));
        this._activeContainers.clear();
    }
}

module.exports = { DockerSandboxService, cleanResult, ensureContainedDirectory };
