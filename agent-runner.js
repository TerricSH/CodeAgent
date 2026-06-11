const client = require('./client');
const EventDispatcher = require('./event-dispatcher');
const tools = require('./tools');

async function runAgentLoop(context, output, options = {}) {
    const dispatcher = new EventDispatcher(output);
    const toolDefs = options.tools || tools.definitions;
    const maxRounds = options.maxRounds || 10;
    const chatOptions = { tools: toolDefs };

    let round = 0;

    while (round < maxRounds) {
        round++;
        const state = dispatcher.createState();

        for await (const event of client.chat(context.getMessages(), chatOptions)) {
            dispatcher.dispatch(event, state);
        }

        if (state.reply) output.content.renderEnd();

        if (!state.pendingToolCalls) {
            if (state.reply) context.addAssistant(state.reply);
            return state.reply;
        }

        // 并行执行工具调用
        context.addAssistantToolCalls(state.pendingToolCalls);

        const results = await Promise.all(
            state.pendingToolCalls.map(async (tc) => {
                output.tool.renderCall(tc.name, tc.arguments);
                const result = await tools.execute(tc.name, tc.arguments, context);
                output.tool.renderResult(tc.name, result);
                return { id: tc.id, result };
            })
        );

        for (const { id, result } of results) {
            context.addToolResult(id, result);
        }
    }

    return '[已达到最大工具调用轮次]';
}

module.exports = runAgentLoop;
