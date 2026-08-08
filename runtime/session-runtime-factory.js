const SessionRuntime = require('./session-runtime');
const { WorkspaceManager } = require('../workspace');

class SessionRuntimeFactory {
    constructor(options = {}) {
        this.registryFactory = options.registryFactory;
    }

    async createChild(options = {}) {
        const workspaceRoot = options.workspaceRoot
            || options.parentContext?.metadata?.workspaceRoot
            || process.cwd();
        const runtime = new SessionRuntime({
            output: options.output,
            model: options.model,
            workspaceManager: new WorkspaceManager({ root: workspaceRoot }),
            registryFactory: this.registryFactory,
            sessionMetadata: options.metadata,
            basePrompt: options.basePrompt,
            capabilityOverrides: options.capabilities,
            toolFilter: options.toolFilter,
        });
        await runtime.start();
        return runtime;
    }
}

module.exports = SessionRuntimeFactory;
