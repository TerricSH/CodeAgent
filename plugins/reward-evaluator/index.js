const { definePlugin } = require('../define-plugin');
const { RewardEvaluator } = require('./service');
const tool = require('./tool');

const NAME = 'reward-evaluator';
const TRAJECTORY = 'trajectory-recorder';

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools: [tool],

    onError(error) {
        throw error;
    },

    onToolResult(context, toolCall, result) {
        const evaluator = context.getExtension(NAME);
        if (!evaluator) return;
        const signal = evaluator.evaluate(toolCall, result);
        if (!signal) return;

        const recorder = context.getExtension(TRAJECTORY);
        if (recorder && typeof recorder.addReward === 'function') {
            recorder.addReward(context, signal);
        }
    },

    init(context, { store, config = {} } = {}) {
        const evaluator = new RewardEvaluator(config);
        return {
            getApi: () => evaluator,
            isDirty: () => evaluator.dirty,
            hydrate: (sessionId) => {
                if (!store || !sessionId) return;
                evaluator.hydrate(store.read(sessionId));
            },
            persist: (sessionId) => {
                if (!store || !sessionId) return;
                store.write(sessionId, evaluator.serialize());
                evaluator.dirty = false;
            },
        };
    },
});
