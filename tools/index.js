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
const skillRefinement = require('./skill-refinement');
const { selectCapabilities } = require('../runtime/capabilities');

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
    skillRefinement,
];

function createRegistry(extraTools = [], options = {}) {
    const registeredTools = [
        ...(options.includeCore === false ? [] : coreTools),
        ...extraTools,
    ];
    const availableCapabilities = options.capabilities || {};
    const validateCapabilities = options.validateCapabilities !== false;
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
        handlers[name] = {
            handler: tool.handler,
            capabilities: selectCapabilities(
                availableCapabilities,
                tool.capabilities,
                `Tool "${name}"`,
                { allowMissing: !validateCapabilities }
            ),
        };
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
            const entry = handlers[name];
            if (!entry) return `未知工具: ${name}`;
            return await entry.handler(args, context, entry.capabilities);
        },
    };
}

// 模块级默认注册表只用于定义枚举与向后兼容；实际运行时必须通过
// createRegistry(..., { capabilities }) 创建并校验依赖。
const defaultRegistry = createRegistry([], { validateCapabilities: false });

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
