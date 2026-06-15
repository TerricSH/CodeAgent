const runCommand = require('./run-command');
const readFile = require('./read-file');
const writeFile = require('./write-file');
const listDir = require('./list-dir');
const activateSkill = require('./activate-skill');
const webSearch = require('./web-search');
const delegateAgent = require('./delegate-agent');
const githubSearch = require('./github-search');

const coreTools = [runCommand, readFile, writeFile, listDir, activateSkill, webSearch, delegateAgent, githubSearch];

function createRegistry(extraTools = []) {
    const registeredTools = [...coreTools, ...extraTools];
    const handlers = {};

    for (const tool of registeredTools) {
        handlers[tool.definition.function.name] = tool.handler;
    }

    function has(name) {
        return Object.prototype.hasOwnProperty.call(handlers, name);
    }

    function names() {
        return Object.keys(handlers);
    }

    return {
        definitions: registeredTools.map(t => t.definition),
        prompts: registeredTools.map(t => t.prompt).filter(Boolean).join('\n\n'),
        has,
        names,
        async execute(name, args, context) {
            const handler = handlers[name];
            if (!handler) return `未知工具: ${name}`;
            return await handler(args, context);
        },
    };
}

const defaultRegistry = createRegistry();

module.exports = {
    coreTools,
    createRegistry,
    // Core-only registry exports. Plugin tools require createRegistry(plugins.getTools()).
    definitions: defaultRegistry.definitions,
    prompts: defaultRegistry.prompts,
    has: defaultRegistry.has,
    names: defaultRegistry.names,
    execute: defaultRegistry.execute,
};
