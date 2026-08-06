const fs = require('fs');
const path = require('path');
const agents = require('../../agents');
const Session = require('../../session');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const INHERITED_RUNTIME_SERVICES = Object.freeze([
    'workspace',
    'fileSystem',
    'commandScope',
    'memoryScope',
    'sandboxScope',
]);

function inheritRuntimeServices(context, ownServices = {}) {
    const services = { ...ownServices };
    for (const name of INHERITED_RUNTIME_SERVICES) {
        const service = context && typeof context.getService === 'function'
            ? context.getService(name)
            : null;
        if (service) services[name] = service;
    }
    return services;
}

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
    const Output = require('../../renderers');
    const runAgentLoop = require('../../agent-runner');
    const providers = require('../../model-providers');
    const { createDefaultRegistry } = require('../../plugins');
    const { baseToolName } = require('../../plugins');

    const subSession = new Session({
        metadata: {
            type: 'subagent',
            agent: agentName,
            parentSessionId: (context && context.sessionId) || null,
            rootSessionId: (context && context.metadata && context.metadata.rootSessionId)
                || (context && context.sessionId)
                || null,
            depth: Number(context && context.metadata && context.metadata.depth || 0) + 1,
            task,
        },
    });

    const subOutput = new Output();
    // 子 agent 模型：用 agent 自己声明的 "厂商/模型" 引用（可与主 agent 完全不同的厂商/模型，
    // 用更便宜/更快的模型省成本提效）；未声明则用默认模型。模型无状态，直接解析。
    const subClient = agentConfig.model ? providers.resolve(agentConfig.model) : providers.resolveDefault();
    // 模型能力转发：与主会话一致，给插件（如 auto-compaction 摘要）提供一次性补全；
    // 子 agent 用自己的 client（可与主 agent 不同），未注入则插件自动降级为不压缩。
    const subModelService = {
        async complete(messages, options = {}) {
            let text = '';
            for await (const event of subClient.chat(messages, options)) {
                if (event && event.type === 'content' && typeof event.content === 'string') {
                    text += event.content;
                }
            }
            return text;
        },
    };
    // 子 agent 继承主运行时已经收窄的 Workspace 能力；output/model 保持子会话独立。
    const subServices = inheritRuntimeServices(context, {
        output: subOutput,
        model: subModelService,
    });
    const subPlugins = createDefaultRegistry({ services: subServices });
    const subToolRegistry = tools.createRegistry(subPlugins.getTools());
    const subContext = new Context(agentConfig.prompt, {
        sessionId: subSession.id,
        metadata: subSession.metadata,
        // 上下文窗口取自子 agent 实际所用的 client，与主 agent 完全隔离。
        maxContextTokens: subClient.maxContextTokens,
        resolveExtension: (name) => subPlugins.resolveApi(name),
        resolveService: (name) => subServices[name] || null,
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

    try {
        const result = await runAgentLoop(subContext, subOutput, {
            tools: allowedTools,
            toolRegistry: subToolRegistry,
            plugins: subPlugins,
            persist: persistSub,
            client: subClient,
        });
        persistSub();
        return result || '[子 agent 未返回结果]';
    } finally {
        await subPlugins.dispose(subContext, { reason: 'subagent-complete' });
    }
}

module.exports = {
    definition,
    handler,
    prompt,
    INHERITED_RUNTIME_SERVICES,
    inheritRuntimeServices,
};
