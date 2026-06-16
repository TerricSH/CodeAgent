const client = require('./client');
const EventDispatcher = require('./event-dispatcher');
const tools = require('./tools');
const turnContinuation = require('./runtime/turn-continuation');

function getToolName(definition) {
    return definition?.function?.name || null;
}

function hasToolHandler(toolRegistry, name) {
    if (typeof toolRegistry.has === 'function') {
        return toolRegistry.has(name);
    }

    return Array.isArray(toolRegistry.definitions)
        && toolRegistry.definitions.some(definition => getToolName(definition) === name);
}

function validateToolRegistry(toolDefs, toolRegistry) {
    if (!toolRegistry || typeof toolRegistry.execute !== 'function') {
        throw new Error('toolRegistry 必须提供 execute(name, args, context)');
    }

    const missing = toolDefs
        .map(getToolName)
        .filter(Boolean)
        .filter(name => !hasToolHandler(toolRegistry, name));

    if (missing.length > 0) {
        throw new Error(`工具定义缺少执行器: ${missing.join(', ')}。过滤 options.tools 时必须传入对应的 toolRegistry。`);
    }
}

async function runAgentLoop(context, output, options = {}) {
    const dispatcher = new EventDispatcher(output);
    const toolRegistry = options.toolRegistry || tools;
    const toolDefs = options.tools || toolRegistry.definitions || [];
    validateToolRegistry(toolDefs, toolRegistry);
    const chatOptions = { tools: toolDefs };
    const plugins = options.plugins || null;

    while (true) {
        const state = dispatcher.createState();

        if (plugins) await plugins.onBeforeTurn(context);

        for await (const event of client.chat(context.getMessages(), chatOptions)) {
            dispatcher.dispatch(event, state);
        }

        if (state.reply) output.content.renderEnd();

        if (!state.pendingToolCalls) {
            if (state.reply) context.addAssistant(state.reply);

            if (plugins) await plugins.onAfterTurn(context, state);

            const guards = plugins ? plugins.getContinuationGuards(context) : [];
            const continuation = turnContinuation.evaluate(context, guards);
            if (continuation.shouldContinue) {
                context.addUser(continuation.reminder);
                continue;
            }

            return state.reply;
        }

        // 并行执行工具调用
        context.addAssistantToolCalls(state.pendingToolCalls);

        const results = await Promise.all(
            state.pendingToolCalls.map(async (tc) => {
                output.tool.renderCall(tc.name, tc.arguments);
                const result = await toolRegistry.execute(tc.name, tc.arguments, context);
                output.tool.renderResult(tc.name, result);
                return {
                    id: tc.id,
                    toolCall: tc,
                    result,
                    finishedAt: new Date().toISOString(),
                };
            })
        );

        for (const { id, toolCall, result, finishedAt } of results) {
            context.addToolResult(id, result, { finishedAt });
            if (plugins) await plugins.onToolResult(context, toolCall, result);
        }
    }
}

module.exports = runAgentLoop;
