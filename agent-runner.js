const client = require('./client');
const EventDispatcher = require('./event-dispatcher');
const tools = require('./tools');
const taskLedgerGuard = require('./task-ledger/guard');

async function runAgentLoop(context, output, options = {}) {
    const dispatcher = new EventDispatcher(output);
    const toolDefs = options.tools || tools.definitions;
    const chatOptions = { tools: toolDefs };

    while (true) {
        const state = dispatcher.createState();

        for await (const event of client.chat(context.getMessages(), chatOptions)) {
            dispatcher.dispatch(event, state);
        }

        if (state.reply) output.content.renderEnd();

        if (!state.pendingToolCalls) {
            if (state.reply) context.addAssistant(state.reply);

            // 如果 task ledger 还有未完成条目，提醒模型继续
            if (taskLedgerGuard.shouldContinue(context)) {
                const reminder = taskLedgerGuard.buildReminder(context);
                if (reminder) {
                    context.addUser(reminder);
                    continue;
                }
            }

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
}

module.exports = runAgentLoop;
