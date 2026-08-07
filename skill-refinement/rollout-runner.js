const Context = require('../context');

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
            description: 'Execute a shell command inside this isolated Skill Refinement workspace.',
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
        has: name => name === 'sandbox_exec',
        async execute(name, args) {
            if (name !== 'sandbox_exec') return `Unknown rollout tool: ${name}`;
            const task = () => executeCommand(args || {});
            const result = queue.then(task, task);
            queue = result.catch(() => {});
            return JSON.stringify(await result, null, 2);
        },
    };
}

function buildRefinementRolloutPrompt({ suite, rolloutId }) {
    const protectedText = suite.protectedPaths.length
        ? suite.protectedPaths.map(item => `- ${item}`).join('\n')
        : '- none';
    return [
        '# Isolated Skill Refinement rollout',
        '',
        `You are rollout ${rolloutId} evaluating a candidate Skill on a controlled task.`,
        'Follow the candidate Skill while solving the task.',
        'Inspect and modify only the provided workspace through sandbox_exec.',
        'A separate fixed evaluator scores the final workspace.',
        'Do not modify protected paths:',
        protectedText,
        '',
        '# Candidate Skill',
        suite.skill,
    ].join('\n');
}

async function runSkillRollout(options) {
    const runAgentLoop = require('../agent-runner');
    const { model, suite, runId, rolloutId, executeCommand } = options;
    if (!model || typeof model.chat !== 'function') {
        throw new Error('Skill Refinement rollouts require a model capability with chat()');
    }
    const context = new Context(buildRefinementRolloutPrompt({ suite, rolloutId }), {
        sessionId: `${runId}:${rolloutId}`,
        metadata: { type: 'skill-refinement-rollout', runId, rolloutId, suiteId: suite.id },
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
    buildRefinementRolloutPrompt,
    runSkillRollout,
};
