const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    normalizeSandboxConfig,
    sessionKey,
} = require('../../sandbox/policy');
const { DockerSandboxExecutor, cleanResult } = require('../../sandbox/executor');
const { pathIsInside, ensureContainedDirectory } = require('../../sandbox/workspace');

const STATE_VERSION = 3;

class DockerSandboxService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.session = sessionKey(this.sessionId);
        this.config = normalizeSandboxConfig(config);
        this.executor = dependencies.executor || new DockerSandboxExecutor({
            config: this.config,
            session: this.session,
            client: dependencies.client,
        });
        this.client = this.executor.client;
        this.sessionRoot = path.join(this.config.sandboxRoot, this.session);
        this.workspace = path.join(this.sessionRoot, 'workspace');
        this.executions = 0;
        this.dirty = false;
        this._queue = Promise.resolve();
        this._activeContainers = this.executor.activeContainers;
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
        const status = await this.executor.status();
        if (!status.available) {
            return {
                available: false,
                imageReady: false,
                image: status.image,
                workspace: this.workspace,
                error: status.error,
            };
        }
        return {
            available: true,
            version: status.version,
            imageReady: status.imageReady,
            image: status.image,
            imageId: status.imageId,
            workspace: this.workspace,
            network: this.config.network,
        };
    }

    execute(args = {}) {
        return this._serialize(async () => {
            const workspace = this._ensureWorkspace();
            const containerName = `codeagent-sbx-${this.session}-${crypto.randomUUID().slice(0, 8)}`;
            const result = await this.executor.execute({
                command: args.command,
                timeoutMs: args.timeoutMs,
                containerName,
                workspace,
            });
            this.executions += 1;
            this.dirty = true;
            return { ...result, execution: this.executions };
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
        await this.executor.dispose();
    }
}

module.exports = { DockerSandboxService, cleanResult, ensureContainedDirectory };
