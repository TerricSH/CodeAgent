const fs = require('node:fs');
const path = require('node:path');
const {
    DockerClient,
    SandboxPool,
    policy: { normalizeSandboxConfig, sessionKey },
    workspace: { pathIsInside, ensureContainedDirectory },
} = require('../../sandbox');

const STATE_VERSION = 4;

class DockerSandboxService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.session = sessionKey(this.sessionId);
        this.config = normalizeSandboxConfig(config);
        this.client = dependencies.client
            || new DockerClient({ command: this.config.command });
        this.pool = dependencies.pool || new SandboxPool(this.config, {
            session: this.session,
            client: this.client,
        });
        this.sessionRoot = path.join(this.config.sandboxRoot, this.session);
        this.workspace = path.join(this.sessionRoot, 'workspace');
        this.executions = 0;
        this.dirty = false;
        this._queue = Promise.resolve();
        this._snapshot = null;
        this._lease = null;
    }

    _ensureWorkspace() {
        return ensureContainedDirectory(this.config.sandboxRoot, this.workspace, 'Sandbox workspace');
    }

    _serialize(task) {
        const next = this._queue.then(task, task);
        this._queue = next.catch(() => {});
        return next;
    }

    async _ensureLease() {
        if (this._lease) return this._lease;
        const workspace = this._ensureWorkspace();
        this._snapshot = await this.pool.prepareSnapshot({
            source: workspace,
            snapshotId: `session:${this.session}`,
        });
        this._lease = await this.pool.acquire(this._snapshot, {
            sessionId: this.sessionId,
            purpose: 'interactive-sandbox',
        });
        return this._lease;
    }

    async _disposeLease() {
        if (this._lease) {
            await this._lease.dispose();
            this._lease = null;
        }
        if (this._snapshot) {
            await this.pool.disposeSnapshot(this._snapshot);
            this._snapshot = null;
        }
    }

    async status() {
        const status = await this.pool.status();
        if (!status.available) {
            return {
                available: false,
                imageReady: false,
                image: status.image,
                workspace: this.workspace,
                pool: status.pool,
                resources: status.resources,
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
            pool: status.pool,
            resources: status.resources,
        };
    }

    execute(args = {}) {
        return this._serialize(async () => {
            const lease = await this._ensureLease();
            const result = await lease.exec(args);
            await lease.exportWorkspace(this.workspace);
            this.executions += 1;
            this.dirty = true;
            return { ...result, execution: this.executions };
        });
    }

    reset() {
        return this._serialize(async () => {
            await this._disposeLease();
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
        if (!envelope || !envelope.data || ![1, 2, 3, STATE_VERSION].includes(envelope.version)) {
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
        await this._disposeLease();
        await this.pool.dispose();
    }
}

module.exports = { DockerSandboxService, ensureContainedDirectory };
