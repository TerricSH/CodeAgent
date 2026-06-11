const readline = require('readline');
require('dotenv').config();
const Context = require('./context');
const Output = require('./output');
const tools = require('./tools');
const runAgentLoop = require('./agent-runner');

const systemPrompt = [process.env.SYSTEM_PROMPT, tools.prompts].filter(Boolean).join('\n\n');
const context = new Context(systemPrompt);
const output = new Output();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

let closed = false;
rl.on('close', () => { closed = true; });

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
            await runAgentLoop(context, output);
        } catch (err) {
            output.error.render(err.message);
        }

        ask();
    });
}

ask();
