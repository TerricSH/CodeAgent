const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

function format(value) {
    return JSON.stringify(value, null, 2);
}

function safe(handler) {
    return async (args, context, manager) => {
        if (!manager) {
            return format({ ok: false, error: 'Training manager extension is unavailable' });
        }
        try {
            return format(await handler(args || {}, context, manager));
        } catch (error) {
            return format({ ok: false, error: error.message });
        }
    };
}

const list = {
    prompt,
    definition: {
        type: 'function',
        function: {
            name: 'training_list',
            description: 'List discovered Python model packages, algorithms, and manifest errors.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler: safe((args, context, manager) => manager.discover()),
};

const check = {
    definition: {
        type: 'function',
        function: {
            name: 'training_check',
            description: 'Check model and algorithm capability compatibility before training.',
            parameters: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    algorithmId: { type: 'string' },
                },
                required: ['modelId'],
            },
        },
    },
    handler: safe((args, context, manager) => manager.check(args.modelId, args.algorithmId)),
};

const start = {
    definition: {
        type: 'function',
        function: {
            name: 'training_start',
            description: 'Start the selected packaged Python trainer with finalized session trajectories.',
            parameters: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    algorithmId: { type: 'string' },
                    trajectoryLimit: { type: 'number' },
                    config: { type: 'object', additionalProperties: true },
                },
                required: ['modelId'],
            },
        },
    },
    handler: safe(async (args, context, manager) => {
        const recorder = context && typeof context.getExtension === 'function'
            ? context.getExtension('trajectory-recorder')
            : null;
        if (!recorder || typeof recorder.getTrajectories !== 'function') {
            throw new Error('Trajectory recorder is unavailable');
        }
        const trajectories = recorder.getTrajectories({ limit: args.trajectoryLimit });
        if (trajectories.length === 0) {
            throw new Error('No finalized trajectories are available for training');
        }
        return await manager.train(args, trajectories);
    }),
};

const history = {
    definition: {
        type: 'function',
        function: {
            name: 'training_history',
            description: 'List recent packaged training runs for the current session.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number' },
                },
                required: [],
            },
        },
    },
    handler: safe((args, context, manager) => ({ runs: manager.history(args.limit) })),
};

module.exports = [list, check, start, history];
