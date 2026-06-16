const readline = require('readline');
require('dotenv').config();
const Context = require('./context');
const Output = require('./output');
const tools = require('./tools');
const runAgentLoop = require('./agent-runner');
const Session = require('./session');
const { buildSystemPrompt } = require('./system-prompt');
const { labels } = require('./output/cli/labels');
const { createDefaultRegistry } = require('./plugins');

async function main() {
    const plugins = createDefaultRegistry();
    const toolRegistry = tools.createRegistry(plugins.getTools());
    const systemPrompt = buildSystemPrompt({
        basePrompt: process.env.SYSTEM_PROMPT,
        toolPrompts: toolRegistry.prompts,
    });
    const output = new Output();
    const session = new Session();
    const context = new Context(systemPrompt, { sessionId: session.id });
    await plugins.init(context);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    function snapshotMessages(ctx) {
        return ctx.messages.map((msg) => {
            const createdAt = msg.created_at || msg.timestamp || new Date().toISOString();
            if (!msg.timestamp) msg.timestamp = createdAt;
            if (!msg.created_at) msg.created_at = createdAt;
            return {
                ...msg,
                finished_at: msg.finished_at || null,
            };
        });
    }

    function persistSession(isClosing = false) {
        return session.save({
            messages: snapshotMessages(context),
            metadata: context.metadata,
            endTime: isClosing ? new Date().toISOString() : null,
        });
    }

    let closed = false;
    rl.on('close', () => {
        closed = true;
        const sessionId = persistSession(true);
        console.log(`对话已保存到 SQLite, sessionId: ${sessionId}`);
        Session.close();
    });

    function ask() {
        if (closed) return;
        const userPrompt = labels['prompt.user'] || '你';
        rl.question(`${userPrompt}: `, async (input) => {
            const text = input.trim();
            if (!text) return ask();
            if (text === 'exit') {
                rl.close();
                return;
            }

            context.addUser(text);
            persistSession();

            try {
                await runAgentLoop(context, output, { plugins, toolRegistry });
                persistSession();
            } catch (err) {
                persistSession();
                output.error.render(err.message);
            }

            ask();
        });
    }

    ask();
}

main().catch((err) => {
    console.error(err.message);
    Session.close();
    process.exitCode = 1;
});
