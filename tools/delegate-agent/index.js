const fs = require('fs');
const path = require('path');
const agents = require('../../agents');
const Session = require('../../session');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const definition = {
    type: 'function',
    function: {
        name: 'delegate_agent',
        description: '将子任务委托给专门的子 agent 执行。可用 agent：\n' + agents.listDescription(),
        parameters: {
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    description: '要委托的 agent 名称',
                    enum: agents.list().map(a => a.name),
                },
                task: {
                    type: 'string',
                    description: '要执行的任务描述',
                },
            },
            required: ['agent', 'task'],
        },
    },
};

async function handler({ agent: agentName, task }, context) {
    const agentConfig = agents.get(agentName);
    if (!agentConfig) return `未知 agent: ${agentName}`;

    // Lazy load to avoid circular dependency with tools/index.js
    const tools = require('../index');

    const Context = require('../../context');
    const Output = require('../../output');
    const runAgentLoop = require('../../agent-runner');
    const providers = require('../../model-providers');
    const { createDefaultRegistry } = require('../../plugins');
    const { baseToolName } = require('../../context/plugins');

    const subSession = new Session({
        metadata: {
            type: 'subagent',
            agent: agentName,
        },
    });

    const subOutput = new Output();
    // 子 agent 模型：用 agent 自己声明的 "厂商/模型" 引用（可与主 agent 完全不同的厂商/模型，
    // 用更便宜/更快的模型省成本提效）；未声明则用默认模型。模型无状态，直接解析。
    const subClient = agentConfig.model ? providers.resolve(agentConfig.model) : providers.resolveDefault();
    // 通用能力注入：与主循环一致，宿主只提供 output 交互层，不感知任何具体插件。
    const subPlugins = createDefaultRegistry({ scope: 'agent', services: { output: subOutput } });
    const subToolRegistry = tools.createRegistry(subPlugins.getTools());
    const subContext = new Context(agentConfig.prompt, {
        sessionId: subSession.id,
        // 上下文窗口取自子 agent 实际所用的 client，与主 agent 完全隔离。
        maxContextTokens: subClient.maxContextTokens,
        resolveExtension: (name) => subPlugins.resolveApi(name),
    });
    await subPlugins.init(subContext);
    subContext.addUser(task);

    // 工具白名单：兼容完整命名空间名与基名，避免插件工具（如 task-ledger__task_ledger）被基名白名单漏掉。
    const allowedTools = agentConfig.tools
        ? subToolRegistry.definitions.filter(t =>
            agentConfig.tools.includes(t.function.name) ||
            agentConfig.tools.includes(baseToolName(t.function.name)))
        : subToolRegistry.definitions;

    // 子会话独立持久化：消息快照 + 扩展态在同一事务原子落库。
    const persistSub = () => subSession.save({
        messages: subContext.snapshotMessages(),
        metadata: {
            ...(subSession.metadata || {}),
            parentSessionId: (context && context.sessionId) || null,
        },
        persist: () => subPlugins.persistAll(subSession.id),
    });

    const result = await runAgentLoop(subContext, subOutput, {
        tools: allowedTools,
        toolRegistry: subToolRegistry,
        plugins: subPlugins,
        persist: persistSub,
        client: subClient,
    });

    persistSub();

    return result || '[子 agent 未返回结果]';
}

module.exports = { definition, handler, prompt };
