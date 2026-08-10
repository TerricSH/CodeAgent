const {
    DockerClient,
    SandboxPool,
    policy: { sessionKey },
} = require('../sandbox');

class SandboxEvaluator {
    constructor(sessionId, config, dependencies = {}) {
        this.session = sessionKey(sessionId);
        this.config = config;
        this.client = dependencies.client || new DockerClient({ command: config.command });
        this.pool = dependencies.pool || new SandboxPool(config, {
            session: this.session,
            client: this.client,
        });
    }

    async status() {
        return this.pool.status();
    }

    prepareSnapshot(source, snapshotId) {
        return this.pool.prepareSnapshot({ source, snapshotId });
    }

    acquire(snapshot, metadata) {
        return this.pool.acquire(snapshot, metadata);
    }

    async execute(args, lease, metadata) {
        if (!lease || typeof lease.exec !== 'function') {
            throw new Error('SandboxEvaluator.execute requires a SandboxLease');
        }
        const result = await lease.exec(args);
        return { ...result, ...metadata };
    }

    disposeSnapshot(snapshot) {
        return this.pool.disposeSnapshot(snapshot);
    }

    async dispose() {
        await this.pool.dispose();
    }
}

module.exports = { SandboxEvaluator };
