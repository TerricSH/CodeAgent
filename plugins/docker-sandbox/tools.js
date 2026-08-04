const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

function format(value) {
    return JSON.stringify(value, null, 2);
}

function errorResult(error) {
    return format({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
    });
}

function safe(handler) {
    return async (args, context, sandbox) => {
        if (!sandbox) return errorResult('Docker sandbox extension is unavailable');
        try {
            return format(await handler(args || {}, sandbox));
        } catch (error) {
            return errorResult(error);
        }
    };
}

const status = {
    prompt,
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_status',
            description: 'Check Docker Engine, sandbox image, isolation policy, and workspace readiness.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler: safe((args, sandbox) => sandbox.status()),
};

const exec = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_exec',
            description: 'Execute a non-interactive shell command inside the isolated Docker workspace.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command executed inside the container.' },
                    timeoutMs: { type: 'number', description: 'Timeout in milliseconds, capped by plugin policy.' },
                    purpose: {
                        type: 'string',
                        enum: ['work', 'evaluation'],
                        description: 'Use evaluation only for commands whose result should produce a training reward.',
                    },
                },
                required: ['command'],
            },
        },
    },
    handler: safe((args, sandbox) => sandbox.execute(args)),
};

const reset = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_reset',
            description: 'Delete and recreate only the current session sandbox workspace.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler: safe((args, sandbox) => sandbox.reset()),
};

const trainingSuites = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_training_suites',
            description: 'List host-defined development-training suites and their fixed evaluation policy.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler: safe((args, sandbox) => sandbox.listTrainingSuites()),
};

const trainingStart = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_training_start',
            description: 'Run multiple isolated agent rollouts for a host-defined suite, evaluate them, and select the best result.',
            parameters: {
                type: 'object',
                properties: {
                    suiteId: {
                        type: 'string',
                        description: 'Identifier from sandbox_training_suites. Task and evaluator cannot be overridden.',
                    },
                },
                required: ['suiteId'],
            },
        },
    },
    handler: safe((args, sandbox) => sandbox.startTraining(args)),
};

const trainingHistory = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_training_history',
            description: 'List recent multi-rollout development-training runs.',
            parameters: {
                type: 'object',
                properties: { limit: { type: 'number' } },
                required: [],
            },
        },
    },
    handler: safe((args, sandbox) => ({ runs: sandbox.trainingHistory(args.limit) })),
};

const trainingResult = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_training_result',
            description: 'Read the ranking, best rollout, and SkillOpt input artifact for a completed training run.',
            parameters: {
                type: 'object',
                properties: { runId: { type: 'string' } },
                required: ['runId'],
            },
        },
    },
    handler: safe((args, sandbox) => sandbox.trainingResult(args.runId)),
};

module.exports = [
    status,
    exec,
    reset,
    trainingSuites,
    trainingStart,
    trainingHistory,
    trainingResult,
];
