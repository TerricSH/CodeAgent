const { definePlugin } = require('../define-plugin');
const { DockerSandboxService } = require('./service');
const tools = require('./tools');

const NAME = 'docker-sandbox';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,
    capabilities: { optional: ['sandboxScope'] },

    onError(error) {
        throw error;
    },

    init(context, { store, config = {}, capabilities = {} } = {}) {
        const scope = capabilities.sandboxScope;
        const effectiveConfig = scope ? {
            ...config,
            projectRoot: config.projectRoot || scope.projectRoot,
            sandboxRoot: config.sandboxRoot || scope.sandboxRoot,
        } : config;
        const sandbox = new DockerSandboxService(context.sessionId, effectiveConfig);
        return {
            getApi: () => sandbox,
            isDirty: () => sandbox.dirty,
            hydrate: async (sessionId) => {
                if (!store || !sessionId) return;
                sandbox.hydrate(await store.read(sessionId));
            },
            persist: async (sessionId, options = {}) => {
                if (!store || !sessionId) return;
                await store.write(sessionId, sandbox.serialize(), options);
                sandbox.dirty = false;
            },
            dispose: () => sandbox.dispose(),
        };
    },
});
