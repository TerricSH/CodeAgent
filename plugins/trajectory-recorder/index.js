const { definePlugin } = require('../define-plugin');
const { TrajectoryRecorder } = require('./service');
const tools = require('./tools');

const NAME = 'trajectory-recorder';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools,

    onError(error) {
        throw error;
    },

    onBeforeTurn(context) {
        const recorder = context.getExtension(NAME);
        if (recorder) recorder.begin(context);
    },

    onToolResult(context, toolCall, result) {
        const recorder = context.getExtension(NAME);
        if (recorder) recorder.recordTool(context, toolCall, result);
    },

    onAfterTurn(context, state) {
        const recorder = context.getExtension(NAME);
        if (recorder) recorder.finalize(context, state);
    },

    init(context, { store, config = {} } = {}) {
        const recorder = new TrajectoryRecorder(context.sessionId, config);
        return {
            getApi: () => recorder,
            isDirty: () => recorder.dirty,
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                recorder.hydrate(store.read(sessionId));
            },
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                store.write(sessionId, recorder.serialize());
                recorder.dirty = false;
            },
        };
    },
});
