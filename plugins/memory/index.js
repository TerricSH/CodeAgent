const { definePlugin } = require('../define-plugin');
const { MemoryRepository } = require('./repository');
const MemoryService = require('./service');
const tools = require('./tools');

const NAME = 'memory';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,

    onError(error) {
        throw error;
    },

    init(context, { store, config = {} } = {}) {
        const memory = new MemoryService(context, new MemoryRepository(), config);
        return {
            getApi: () => memory,
            isDirty: () => memory.dirty,
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                memory.hydrate(store.read(sessionId));
            },
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                store.write(sessionId, memory.serialize());
                memory.dirty = false;
            },
            dispose: () => memory.dispose(),
        };
    },

    onSessionResume(context) {
        const memory = context.getExtension(NAME);
        if (memory) memory.markResumed();
    },

    onBeforeTurn(context) {
        const memory = context.getExtension(NAME);
        if (memory) memory.prepareOverlays();
    },

    onAfterTurn(context) {
        const memory = context.getExtension(NAME);
        if (memory) memory.updateFocus();
    },
});
