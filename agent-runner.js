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
    // 模型由宿主注入（公共 ModelRuntime 或具体连接）；runner 不感知模型来源，只调 chat。
    const client = options.client;
    if (!client || typeof client.chat !== 'function') {
        throw new Error('runAgentLoop 需要注入 options.client（提供 chat 的模型运行时/连接）');
    }
    const toolRegistry = options.toolRegistry || tools;
    const toolDefs = options.tools || toolRegistry.definitions || [];
    validateToolRegistry(toolDefs, toolRegistry);
    const chatOptions = { tools: toolDefs };
    const plugins = options.plugins || null;
    // 安全保存点回调：仅在“消息成对完整 + 扩展态已结算”的边界调用。
    const persist = typeof options.persist === 'function' ? options.persist : null;

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

            // 安全保存点：assistant 回复已落定。
            if (persist) persist();

            const guards = plugins ? plugins.getContinuationGuards(context) : [];
            const continuation = turnContinuation.evaluate(context, guards);
            if (continuation.shouldContinue) {
                context.addUser(continuation.reminder);
                if (persist) persist();
                continue;
            }

            return state.reply;
        }

        // 并行执行工具调用
        context.addAssistantToolCalls(state.pendingToolCalls);

        const results = await Promise.all(
            state.pendingToolCalls.map(async (tc) => {
                output.tool.renderCall(tc.name, tc.arguments);
                // 单个工具抛错降级为结果字符串：保证每条 tool_calls 都有配对的 tool 结果，
                // 否则整组 Promise.all 失败会留下悬空 assistant.tool_calls，污染持久化状态。
                let result;
                try {
                    result = await toolRegistry.execute(tc.name, tc.arguments, context);
                } catch (err) {
                    result = `工具执行失败: ${err && err.message ? err.message : String(err)}`;
                }
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

        // 安全保存点：整组工具结果已写入且配对完整、插件态已结算。
        if (persist) persist();
    }
}

module.exports = runAgentLoop;
