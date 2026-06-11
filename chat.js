const readline = require('readline');
require('dotenv').config();
const ModelClient = require('./model');
const Context = require('./context');
const Output = require('./output');
const HandlerFactory = require('./handlers');
const tools = require('./tools');

const client = new ModelClient({
    apiKey: process.env.API_KEY,
    baseURL: process.env.API_BASE_URL,
    model: process.env.MODEL_NAME || 'mimo-v2.5-pro',
});

const systemPrompt = [process.env.SYSTEM_PROMPT, tools.prompts].filter(Boolean).join('\n\n');
const context = new Context(systemPrompt);
const output = new Output();
const factory = new HandlerFactory(output);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

let closed = false;
rl.on('close', () => { closed = true; });

async function handleResponse() {
    const chatOptions = { tools: tools.definitions };

    while (true) {
        const state = factory.createState();

        for await (const event of client.chat(context.getMessages(), chatOptions)) {
            const handler = factory.get(event.type);
            if (handler) handler.handle(event, state);
        }

        if (state.reply) console.log('\n');

        if (!state.pendingToolCalls) {
            if (state.reply) context.addAssistant(state.reply);
            break;
        }

        // 执行工具调用
        context.addAssistantToolCalls(state.pendingToolCalls);
        for (const tc of state.pendingToolCalls) {
            output.toolCall(tc.name, tc.arguments);
            const result = tools.execute(tc.name, tc.arguments, context);
            output.toolResult(tc.name, result);
            context.addToolResult(tc.id, result);
        }
        // 继续让模型处理工具结果
    }
}

function ask() {
    if (closed) return;
    rl.question('你: ', async (input) => {
        const text = input.trim();
        if (!text) return ask();
        if (text === 'exit') {
            rl.close();
            return;
        }

        context.addUser(text);

        try {
            await handleResponse();
        } catch (err) {
            output.error(err.message);
        }

        ask();
    });
}

ask();
