const runCommand = require('./run-command');
const readFile = require('./read-file');
const readFiles = require('./read-files');
const writeFile = require('./write-file');
const writeFiles = require('./write-files');
const listDir = require('./list-dir');
const activateSkill = require('./activate-skill');
const skillSearch = require('./skill-search');
const deactivateSkill = require('./deactivate-skill');
const webSearch = require('./web-search');
const delegateAgent = require('./delegate-agent');
const githubSearch = require('./github-search');
const rag = require('./rag');
const skillRefinement = require('./skill-refinement');
const trajectoryExtract = require('./trajectory-extract');
const imageInspect = require('./image-inspect');
const { selectCapabilities } = require('../runtime/capabilities');

const TOOL_EFFECTS = Object.freeze(['read', 'control', 'write', 'execute', 'external']);

const coreTools = [
    runCommand,
    readFile,
    readFiles,
    writeFile,
    writeFiles,
    listDir,
    activateSkill,
    skillSearch,
    deactivateSkill,
    webSearch,
    delegateAgent,
    githubSearch,
    rag,
    skillRefinement,
    trajectoryExtract,
    imageInspect,
];

function createRegistry(extraTools = [], options = {}) {
    const registeredTools = [
        ...(options.includeCore === false ? [] : coreTools),
        ...extraTools,
    ].filter(tool => typeof options.toolFilter !== 'function' || options.toolFilter(tool));
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
        if (tool.effects !== undefined
            && typeof tool.effects !== 'function'
            && !TOOL_EFFECTS.includes(tool.effects)) {
            throw new TypeError(`Tool "${name}" declares an invalid effects value`);
        }
        handlers[name] = {
            handler: tool.handler,
            effects: tool.effects,
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

    function describe(name, args = {}) {
        const entry = handlers[name];
        if (!entry) return Object.freeze({ name, effects: 'unknown' });
        const effects = typeof entry.effects === 'function'
            ? entry.effects(args || {})
            : (entry.effects || 'unknown');
        return Object.freeze({
            name,
            effects: TOOL_EFFECTS.includes(effects) ? effects : 'unknown',
        });
    }

    async function preflight(calls = [], context) {
        const batch = Object.freeze((Array.isArray(calls) ? calls : []).map(call => Object.freeze({
            id: call?.id || null,
            ...describe(call?.name, call?.arguments || {}),
        })));
        if (typeof options.onBeforeBatch === 'function') {
            await options.onBeforeBatch(context, batch);
        }
        return batch;
    }

    return {
        definitions: registeredTools.map(t => t.definition),
        prompts: registeredTools.map(t => t.prompt).filter(Boolean).join('\n\n'),
        has,
        names,
        describe,
        preflight,
        async execute(name, args, context) {
            const entry = handlers[name];
            if (!entry) return `未知工具: ${name}`;
            const tool = describe(name, args || {});
            if (typeof options.onBeforeExecute === 'function') {
                await options.onBeforeExecute(context, tool, args || {});
            }
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
    describe: defaultRegistry.describe,
    preflight: defaultRegistry.preflight,
    execute: defaultRegistry.execute,
    TOOL_EFFECTS,
};
