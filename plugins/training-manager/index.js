const { definePlugin } = require('../define-plugin');
const { ModelPackageManager } = require('../../training');
const tools = require('./tools');

const NAME = 'training-manager';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,

    onError(error) {
        throw error;
    },

    init(context, { store, config = {} } = {}) {
        const manager = new ModelPackageManager(config);
        manager.discover();
        return {
            getApi: () => manager,
            isDirty: () => manager.dirty,
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                manager.hydrate(store.read(sessionId));
            },
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                store.write(sessionId, manager.serialize());
                manager.dirty = false;
            },
            dispose: () => manager.dispose(),
        };
    },
});
