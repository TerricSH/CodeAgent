const fs = require('fs');
const path = require('path');
const agents = require('../../agents');
const tools = require('../index');

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

async function handler({ agent: agentName, task }) {
    const agentConfig = agents.get(agentName);
    if (!agentConfig) return `未知 agent: ${agentName}`;

    const Context = require('../../context');
    const Output = require('../../output');
    const runAgentLoop = require('../../agent-runner');

    const subContext = new Context(agentConfig.prompt);
    subContext.addUser(task);

    const subOutput = new Output();

    // 过滤子 agent 允许的工具
    const allowedTools = agentConfig.tools
        ? tools.definitions.filter(t => agentConfig.tools.includes(t.function.name))
        : tools.definitions;

    const result = await runAgentLoop(subContext, subOutput, {
        tools: allowedTools,
        maxRounds: 10,
    });

    return result || '[子 agent 未返回结果]';
}

module.exports = { definition, handler, prompt };
