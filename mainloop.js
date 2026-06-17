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
    const context = new Context(systemPrompt, {
        sessionId: session.id,
        resolveExtension: (name) => plugins.resolveApi(name),
    });
    await plugins.init(context);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // 原子持久化 + 脏标记节流：消息快照与扩展态在同一事务落库，无变化则跳过。
    let lastSavedCount = 0;
    function atomicPersist(isClosing = false) {
        const messages = context.snapshotMessages();
        const dirty = isClosing || messages.length !== lastSavedCount || plugins.isDirty();
        if (!dirty) return session.id;

        const id = session.save({
            messages,
            metadata: context.metadata,
            endTime: isClosing ? new Date().toISOString() : null,
            persist: () => plugins.persistAll(session.id),
        });
        lastSavedCount = messages.length;
        return id;
    }

    let closed = false;
    rl.on('close', () => {
        closed = true;
        const sessionId = atomicPersist(true);
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
            atomicPersist();

            try {
                await runAgentLoop(context, output, { plugins, toolRegistry, persist: () => atomicPersist() });
                atomicPersist();
            } catch (err) {
                atomicPersist();
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
