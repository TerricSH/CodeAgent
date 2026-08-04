const Context = require('../../context');

function silentOutput() {
    const noop = () => {};
    return {
        thinking: { renderStart: noop, render: noop, renderEnd: noop },
        content: { renderStart: noop, render: noop, renderEnd: noop },
        tool: { renderCall: noop, renderResult: noop },
        error: { render: noop },
    };
}

function createRolloutTools(executeCommand) {
    const definition = {
        type: 'function',
        function: {
            name: 'sandbox_exec',
            description: 'Execute a shell command inside this rollout workspace.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    timeoutMs: { type: 'number' },
                },
                required: ['command'],
            },
        },
    };
    let queue = Promise.resolve();
    return {
        definitions: [definition],
        has: (name) => name === 'sandbox_exec',
        async execute(name, args) {
            if (name !== 'sandbox_exec') return `Unknown rollout tool: ${name}`;
            const task = () => executeCommand(args || {});
            const result = queue.then(task, task);
            queue = result.catch(() => {});
            return JSON.stringify(await result, null, 2);
        },
    };
}

function buildTrainingPrompt({ suite, rolloutId }) {
    const protectedText = suite.protectedPaths.length
        ? suite.protectedPaths.map((item) => `- ${item}`).join('\n')
        : '- none';
    return [
        '# Isolated development training rollout',
        '',
        `You are rollout ${rolloutId} in a controlled development-training experiment.`,
        'Inspect and modify only the provided workspace through sandbox_exec.',
        'Do not claim success from your own tests; a separate evaluator scores the final workspace.',
        'Do not modify protected paths:',
        protectedText,
        'Investigate, implement, and run useful checks. End with a concise summary when the task is complete.',
        suite.skill ? `\n# Current candidate skill\n${suite.skill}` : '',
    ].filter(Boolean).join('\n');
}

async function runAgentRollout(options) {
    const runAgentLoop = require('../../agent-runner');
    const { model, suite, runId, rolloutId, executeCommand } = options;
    if (!model || typeof model.chat !== 'function') {
        throw new Error('Training rollouts require a model service with chat()');
    }
    const context = new Context(buildTrainingPrompt({ suite, rolloutId }), {
        sessionId: `${runId}:${rolloutId}`,
        metadata: { type: 'training-rollout', runId, rolloutId, suiteId: suite.id },
    });
    const info = typeof model.info === 'function' ? model.info() : null;
    if (info && Number.isInteger(info.maxContextTokens)) {
        context.setMaxContextTokens(info.maxContextTokens);
    }
    context.addUser(suite.task);
    const toolRegistry = createRolloutTools(executeCommand);
    const reply = await runAgentLoop(context, silentOutput(), {
        client: model,
        toolRegistry,
        tools: toolRegistry.definitions,
    });
    return {
        reply: reply || '',
        messages: context.snapshotMessages(),
    };
}

module.exports = {
    silentOutput,
    createRolloutTools,
    buildTrainingPrompt,
    runAgentRollout,
};
