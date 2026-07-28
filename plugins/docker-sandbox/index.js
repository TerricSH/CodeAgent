const { definePlugin } = require('../define-plugin');
const { DockerSandboxService } = require('./service');
const tools = require('./tools');

const NAME = 'docker-sandbox';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,

    onError(error) {
        throw error;
    },

    init(context, { store, config = {} } = {}) {
        const sandbox = new DockerSandboxService(context.sessionId, config);
        return {
            getApi: () => sandbox,
            isDirty: () => sandbox.dirty,
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                sandbox.hydrate(store.read(sessionId));
            },
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                store.write(sessionId, sandbox.serialize());
                sandbox.dirty = false;
            },
            dispose: () => sandbox.dispose(),
        };
    },
});
