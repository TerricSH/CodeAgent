const crypto = require('node:crypto');
const { sessionKey } = require('../sandbox/policy');
const { DockerSandboxExecutor, cleanResult } = require('../sandbox/executor');
const { ensureContainedDirectory } = require('../sandbox/workspace');

class SandboxEvaluator {
    constructor(sessionId, config, dependencies = {}) {
        this.session = sessionKey(sessionId);
        this.config = config;
        this.executor = dependencies.executor || new DockerSandboxExecutor({
            config,
            session: this.session,
            client: dependencies.client,
        });
        this.client = this.executor.client;
        this._activeContainers = this.executor.activeContainers;
    }

    async status() {
        return this.executor.status();
    }

    async execute(args, workspace, metadata) {
        const realWorkspace = ensureContainedDirectory(
            this.config.sandboxRoot,
            workspace,
            'Skill Refinement rollout workspace'
        );
        const containerName = `codeagent-refine-${this.session}-${metadata.rolloutId}-${crypto.randomUUID().slice(0, 8)}`;
        const result = await this.executor.execute({
            command: args.command,
            timeoutMs: args.timeoutMs,
            containerName,
            workspace: realWorkspace,
        });
        return { ...result, ...metadata };
    }

    async dispose() {
        await this.executor.dispose();
    }
}

module.exports = { SandboxEvaluator, cleanResult };
