const { definePlugin } = require('../define-plugin');
const { MemoryRepository } = require('./repository');
const MemoryService = require('./service');
const tools = require('./tools');

const NAME = 'memory';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,
    capabilities: { optional: ['memoryScope'] },

    onError(error) {
        throw error;
    },

    init(context, { store, config = {}, capabilities = {} } = {}) {
        const memory = new MemoryService(context, new MemoryRepository(), {
            ...config,
            projectKey: config.projectKey || capabilities.memoryScope?.projectKey,
        });
        return {
            getApi: () => memory,
            isDirty: () => memory.dirty,
            hydrate: async (sessionId) => {
                if (!store || !sessionId) return;
                memory.hydrate(await store.read(sessionId));
            },
            persist: async (sessionId, options = {}) => {
                if (!store || !sessionId) return;
                await store.write(sessionId, memory.serialize(), options);
                memory.dirty = false;
            },
            dispose: () => memory.dispose(),
        };
    },

    onSessionResume(context) {
        const memory = context.getExtension(NAME);
        if (memory) memory.markResumed();
    },

    async onBeforeTurn(context) {
        const memory = context.getExtension(NAME);
        if (memory) await memory.prepareOverlays();
    },

    onAfterTurn(context) {
        const memory = context.getExtension(NAME);
        if (memory) memory.updateFocus();
    },
});
