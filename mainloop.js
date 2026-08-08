const readline = require('readline');
require('dotenv').config();
const Output = require('./renderers');
const runAgentLoop = require('./agent-runner');
const Session = require('./session');
const { labels } = require('./renderers/cli/labels');
const SessionRuntime = require('./runtime/session-runtime');
const ModelRuntime = require('./runtime/model-runtime');
const commands = require('./runtime/commands');

async function main() {
    const output = new Output();
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    // 核心 IO 组装：把共享 readline 交给交互收集器，供其在选择期间 pause/resume，避免按键串扰。
    if (output.prompt && typeof output.prompt.setInput === 'function') {
        output.prompt.setInput(rl);
    }

    // 公共模型运行时：拥有当前模型连接，与 session 解耦；mainloop 只调它的接口。
    const modelRuntime = new ModelRuntime();

    // 会话运行时：拥有 context/plugins/toolRegistry，负责持久化与“两轮之间”的会话切换。
    const runtime = await new SessionRuntime({ output, model: modelRuntime }).start();
    // 宿主把当前模型的上下文窗口同步给 Context 作 token 预算（Context 不感知模型）。
    runtime.context.setMaxContextTokens(modelRuntime.maxContextTokens);

    let closed = false;
    rl.on('close', async () => {
        closed = true;
        const sessionId = await runtime.persist({ closing: true });
        console.log(`对话已保存到 PostgreSQL, sessionId: ${sessionId}`);
        await runtime.dispose('close');
        await Session.close();
    });

    // 切换只在空闲安全点执行：persist-before + 重建替换，绝不在流式/工具/ask-user 中途。
    // runtime 只返回结构化事件，显示文本由命令层用 labels 格式化。
    async function applyPendingIfAny() {
        if (!runtime.hasPending()) return;
        const event = await runtime.applyPending();
        // 会话重建后，宿主重新把当前模型预算同步给新的 Context。
        runtime.context.setMaxContextTokens(modelRuntime.maxContextTokens);
        const msg = commands.presentEvent(event, { labels });
        if (msg) console.log(msg);
    }

    function ask() {
        if (closed) return;
        // 上下文用量状态栏（CLI）：每次输入前显示当前已用/限额。
        if (output.status) output.status.render(runtime.context.usage());
        const userPrompt = labels['prompt.user'] || '你';
        rl.question(`${userPrompt}: `, async (input) => {
            const text = input.trim();
            if (!text) return ask();
            if (text === 'exit') {
                rl.close();
                return;
            }

            // 命令层（含会话切换）：通用分发，mainloop 不感知有哪些具体命令。
            const cmd = await commands.dispatch(text, { runtime, labels });
            if (cmd.handled) {
                if (cmd.message) console.log(cmd.message);
                await applyPendingIfAny();
                return ask();
            }

            runtime.context.addUser(text);
            await runtime.persist();

            try {
                await runAgentLoop(runtime.context, output, {
                    plugins: runtime.plugins,
                    toolRegistry: runtime.toolRegistry,
                    persist: () => runtime.persist(),
                    client: modelRuntime,
                });
                await runtime.persist();
            } catch (err) {
                await runtime.persist();
                output.error.render(err.message);
            }

            // 模型/工具发起的切换意图，在轮末安全点执行。
            await applyPendingIfAny();
            ask();
        });
    }

    ask();
}

main().catch(async (err) => {
    console.error(err.message);
    await Session.close().catch(() => {});
    process.exitCode = 1;
});
