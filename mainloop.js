const readline = require('readline');
require('dotenv').config();
const Context = require('./context');
const Output = require('./output');
const tools = require('./tools');
const runAgentLoop = require('./agent-runner');
const Session = require('./session');
const { buildSystemPrompt } = require('./system-prompt');

const systemPrompt = buildSystemPrompt({
    basePrompt: process.env.SYSTEM_PROMPT,
    toolPrompts: tools.prompts,
});
const output = new Output();
const session = new Session();
const context = new Context(systemPrompt, { sessionId: session.id });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

let closed = false;
rl.on('close', () => {
    closed = true;
    const sessionId = session.save();
    console.log(`对话已保存到 SQLite, sessionId: ${sessionId}`);
    Session.close();
});

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
        session.add({ role: 'user', content: text });

        try {
            const reply = await runAgentLoop(context, output);
            if (reply) session.add({ role: 'assistant', content: reply });
        } catch (err) {
            output.error.render(err.message);
        }

        ask();
    });
}

ask();
