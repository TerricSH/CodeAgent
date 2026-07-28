const format = (value) => JSON.stringify(value, null, 2);

function unavailable() {
    return format({ ok: false, error: 'Trajectory recorder extension is unavailable' });
}

const list = {
    definition: {
        type: 'function',
        function: {
            name: 'trajectory_list',
            description: 'List recent reinforcement-learning trajectories and their rewards.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of recent trajectories, up to 100.' },
                },
                required: [],
            },
        },
    },
    handler(args, context, recorder) {
        if (!recorder) return unavailable();
        return format({ trajectories: recorder.list(args || {}) });
    },
};

const exportTool = {
    definition: {
        type: 'function',
        function: {
            name: 'trajectory_export',
            description: 'Export finalized trajectories for the current session as JSONL training data.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler(args, context, recorder) {
        if (!recorder) return unavailable();
        try {
            return format({ ok: true, ...recorder.exportJsonl() });
        } catch (error) {
            return format({ ok: false, error: error.message });
        }
    },
};

module.exports = [list, exportTool];
