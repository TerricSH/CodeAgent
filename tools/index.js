const runCommand = require('./run-command');
const readFile = require('./read-file');
const writeFile = require('./write-file');
const listDir = require('./list-dir');
const activateSkill = require('./activate-skill');
const webSearch = require('./web-search');
const delegateAgent = require('./delegate-agent');

const tools = [runCommand, readFile, writeFile, listDir, activateSkill, webSearch, delegateAgent];

const definitions = tools.map(t => t.definition);
const prompts = tools.map(t => t.prompt).join('\n\n');

const handlers = {};
for (const t of tools) {
    handlers[t.definition.function.name] = t.handler;
}

async function execute(name, args, context) {
    const handler = handlers[name];
    if (!handler) return `未知工具: ${name}`;
    return await handler(args, context);
}

module.exports = { definitions, prompts, execute };
