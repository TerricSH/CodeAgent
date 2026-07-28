const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DockerClient } = require('./docker-client');
const {
    normalizeConfig,
    sessionKey,
    clampTimeout,
    buildRunArgs,
} = require('./policy');

const STATE_VERSION = 1;

function cleanResult(result) {
    return {
        ok: result.exitCode === 0 && !result.timedOut && !result.error,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: Boolean(result.timedOut),
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        truncated: Boolean(result.truncated),
        error: result.error || null,
        errorCode: result.errorCode || null,
        durationMs: result.durationMs,
    };
}

class DockerSandboxService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.session = sessionKey(this.sessionId);
        this.config = normalizeConfig(config);
        this.client = dependencies.client || new DockerClient({ command: this.config.command });
        this.workspace = path.join(this.config.sandboxRoot, this.session, 'workspace');
        this.executions = 0;
        this.dirty = false;
        this._queue = Promise.resolve();
        this._activeContainers = new Set();
    }

    _ensureWorkspace() {
        const root = path.resolve(this.config.sandboxRoot);
        const workspace = path.resolve(this.workspace);
        if (workspace !== root && !workspace.startsWith(`${root}${path.sep}`)) {
            throw new Error('Sandbox workspace escaped its configured root');
        }
        fs.mkdirSync(workspace, { recursive: true });

        if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
            const [uid, gid] = this.config.user.split(':').map(Number);
            if (Number.isInteger(uid) && Number.isInteger(gid)) {
                fs.chownSync(workspace, uid, gid);
            }
        }
        return workspace;
    }

    _serialize(task) {
        const next = this._queue.then(task, task);
        this._queue = next.catch(() => {});
        return next;
    }

    async status() {
        const version = await this.client.version({
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        });
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
            const timeoutMs = clampTimeout(args.timeoutMs, this.config);
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
                    timeoutMs,
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
            return {
                ...cleanResult(result),
                purpose: args.purpose === 'evaluation' ? 'evaluation' : 'work',
                execution: this.executions,
            };
        });
    }

    reset() {
        return this._serialize(async () => {
            const root = path.resolve(this.config.sandboxRoot);
            const workspace = path.resolve(this.workspace);
            if (!workspace.startsWith(`${root}${path.sep}`)) {
                throw new Error('Refusing to reset a workspace outside the sandbox root');
            }
            fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
            this.executions = 0;
            this.dirty = true;
            return { reset: true, workspace };
        });
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || envelope.version !== STATE_VERSION || !envelope.data) {
            throw new Error('Invalid docker-sandbox state envelope');
        }
        this.executions = Number.isInteger(envelope.data.executions) ? envelope.data.executions : 0;
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            name: 'docker-sandbox',
            version: STATE_VERSION,
            data: {
                session: this.session,
                executions: this.executions,
            },
        });
    }

    async dispose() {
        const names = [...this._activeContainers];
        await Promise.all(names.map((name) => this.client.removeContainer(name, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        })));
        this._activeContainers.clear();
    }
}

module.exports = { DockerSandboxService, cleanResult };
