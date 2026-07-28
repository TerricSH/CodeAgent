const definition = {
    type: 'function',
    function: {
        name: 'reward_summary',
        description: 'Show the accumulated automatic evaluation rewards for the current session.',
        parameters: { type: 'object', properties: {}, required: [] },
    },
};

function handler(args, context, evaluator) {
    if (!evaluator) {
        return JSON.stringify({ ok: false, error: 'Reward evaluator extension is unavailable' });
    }
    return JSON.stringify(evaluator.summary(), null, 2);
}

module.exports = { definition, handler };
