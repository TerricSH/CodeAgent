const runCommand = require('./run-command');
const readFile = require('./read-file');
const readFiles = require('./read-files');
const writeFile = require('./write-file');
const writeFiles = require('./write-files');
const listDir = require('./list-dir');
const activateSkill = require('./activate-skill');
const webSearch = require('./web-search');
const delegateAgent = require('./delegate-agent');
const githubSearch = require('./github-search');
const rag = require('./rag');

const coreTools = [
    runCommand,
    readFile,
    readFiles,
    writeFile,
    writeFiles,
    listDir,
    activateSkill,
    webSearch,
    delegateAgent,
    githubSearch,
    rag,
];

function createRegistry(extraTools = []) {
    const registeredTools = [...coreTools, ...extraTools];
    const handlers = {};

    for (const tool of registeredTools) {
        const name = tool && tool.definition && tool.definition.function
            ? tool.definition.function.name
            : null;
        if (typeof name !== 'string' || !name || typeof tool.handler !== 'function') {
            throw new TypeError('Invalid tool registration');
        }
        if (Object.prototype.hasOwnProperty.call(handlers, name)) {
            throw new Error(`Duplicate tool registration: ${name}`);
        }
        handlers[name] = tool.handler;
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
