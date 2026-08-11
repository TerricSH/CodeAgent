const Context = require('../context');
const crypto = require('node:crypto');
const path = require('node:path');
const { loadPrompt, loadPromptTemplate } = require('../prompts/loader');

const renderRolloutSystem = loadPromptTemplate(path.join(__dirname, 'prompts', 'rollout-system.md'));
const renderProtectedPath = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'protected-path-item.md')
);
const NO_PROTECTED_PATHS = loadPrompt(
    path.join(__dirname, 'prompts', 'no-protected-paths.md')
);

function silentOutput() {
    const noop = () => {};
    return {
        thinking: { renderStart: noop, render: noop, renderEnd: noop },
        content: { renderStart: noop, render: noop, renderEnd: noop },
        tool: { renderCall: noop, renderResult: noop },
        error: { render: noop },
    };
}

function createRolloutTools(executeCommand, trajectoryJournal = null, trajectoryContext = null) {
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
        async execute(name, args, _context, execution = {}) {
            if (name !== 'sandbox_exec') return `Unknown rollout tool: ${name}`;
            const toolCallId = execution.toolCallId || crypto.randomUUID();
            const task = async () => {
                trajectoryJournal?.recordSemanticEvent({
                    eventId: crypto.randomUUID(),
                    type: 'tool_started',
                    recordType: 'tool-event',
                    purpose: 'execution',
                    content: null,
                    payload: {
                        toolCallId,
                        name,
                        arguments: args || {},
                        context: trajectoryContext,
                    },
                });
                try {
                    const value = await executeCommand(args || {});
                    const infrastructureFailure = ['oom', 'timeout', 'infrastructure']
                        .includes(value?.failureType);
                    trajectoryJournal?.recordSemanticEvent({
                        eventId: crypto.randomUUID(),
                        type: 'tool_result',
                        recordType: 'tool-event',
                        purpose: 'execution',
                        content: JSON.stringify(value),
                        payload: {
                            toolCallId,
                            name,
                            status: infrastructureFailure ? 'failed' : 'succeeded',
                            errorCode: infrastructureFailure
                                ? (value?.errorCode || `SANDBOX_${value.failureType.toUpperCase()}`)
                                : null,
                            context: trajectoryContext,
                        },
                    });
                    return value;
                } catch (error) {
                    trajectoryJournal?.recordSemanticEvent({
                        eventId: crypto.randomUUID(),
                        type: 'tool_result',
                        recordType: 'tool-event',
                        purpose: 'execution',
                        content: error instanceof Error ? error.message : String(error),
                        payload: {
                            toolCallId,
                            name,
                            status: 'failed',
                            errorCode: error?.code || null,
                            context: trajectoryContext,
                        },
                    });
                    throw error;
                }
            };
            const result = queue.then(task, task);
            queue = result.catch(() => {});
            return JSON.stringify(await result, null, 2);
        },
    };
}

function buildRefinementRolloutPrompt({ suite, rolloutId }) {
    const protectedText = suite.protectedPaths.length
        ? suite.protectedPaths.map(item => renderProtectedPath({ path: item })).join('\n')
        : NO_PROTECTED_PATHS;
    return renderRolloutSystem({
        rolloutId,
        protectedPaths: protectedText,
        skill: suite.skill,
    });
}

async function runSkillRollout(options) {
    const runAgentLoop = require('../agent-runner');
    const { model, suite, runId, rolloutId, executeCommand, trajectoryJournal } = options;
    if (!model || typeof model.chat !== 'function') {
        throw new Error('Skill Refinement rollouts require a model capability with chat()');
    }
    const context = new Context(buildRefinementRolloutPrompt({ suite, rolloutId }), {
        sessionId: `${runId}:${rolloutId}`,
        metadata: {
            type: 'skill-refinement-rollout',
            runId,
            rolloutId,
            suiteId: suite.id,
            split: suite.taskItem?.split || null,
            taskId: suite.taskItem?.id || null,
        },
    });
    const info = typeof model.info === 'function' ? model.info() : null;
    if (info && Number.isInteger(info.maxContextTokens)) {
        context.setMaxContextTokens(info.maxContextTokens);
    }
    context.addUser(suite.task);
    const trajectoryContext = {
        runId,
        rolloutId,
        suiteId: suite.id,
        ...(options.trajectoryContext || {}),
    };
    const toolRegistry = createRolloutTools(executeCommand, trajectoryJournal, trajectoryContext);
    const reply = await runAgentLoop(context, silentOutput(), {
        client: model,
        toolRegistry,
        tools: toolRegistry.definitions,
        modelOptions: {
            purpose: 'execution',
            trajectoryContext,
        },
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
