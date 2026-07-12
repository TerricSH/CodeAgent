// 扩展（插件）注册表 / 宿主编排器。
// 负责：所有权绑定、工具命名空间化、执行期注入 ext、原子持久化编排、
// hydrate 时机、隔离与降级。扩展状态本体不进 context。
const NAMESPACE_SEPARATOR = '__';
const PluginError = require('./plugin-error');
const { validatePlugin } = require('./define-plugin');

class PluginRegistry {
    constructor(options = {}) {
        this.entries = [];
        this.storeFactory = typeof options.storeFactory === 'function' ? options.storeFactory : null;
        // 宿主注入的通用能力（如 output 交互层）；不针对任何具体插件，所有插件 init 时均可取用。
        this.services = options.services && typeof options.services === 'object' ? options.services : {};
        if (Array.isArray(options.plugins)) {
            for (const plugin of options.plugins) {
                this.register(plugin);
            }
        }
    }

    register(plugin, config = {}) {
        validatePlugin(plugin);

        if (config.enabled === false) {
            return null;
        }

        if (this.entries.some((entry) => entry.plugin.name === plugin.name)) {
            throw new Error(`Duplicate plugin registration: ${plugin.name}`);
        }

        this.entries.push({ plugin, config, owner: plugin.name, extension: null });
        return plugin;
    }

    list() {
        return this.entries.map(({ plugin }) => plugin);
    }

    get(name) {
        const entry = this.entries.find(({ plugin }) => plugin.name === name);
        return entry ? entry.plugin : null;
    }

    // 初始化每个扩展：注入作用域 store + config，得到扩展实例；随后 hydrate。
    // 单个扩展 hydrate 失败按降级处理，不影响其它扩展与主流程。
    async init(context) {
        for (const entry of this.entries) {
            const store = this.storeFactory ? this.storeFactory(entry.plugin.name) : null;
            const extension = await this._invoke(
                entry,
                'init',
                entry.plugin.init,
                [context, { store, config: entry.config, services: this.services }]
            );
            entry.extension = extension || null;

            if (entry.extension && typeof entry.extension.hydrate === 'function') {
                await this._invoke(entry, 'hydrate', entry.extension.hydrate, [context.sessionId]);
            }
        }
    }

    // 解析扩展对外公开 API（即 tools/guards 拿到的 ext）。
    resolveApi(name) {
        const entry = this.entries.find((e) => e.plugin.name === name);
        if (!entry || !entry.extension || typeof entry.extension.getApi !== 'function') return null;
        return this._invokeSync(entry, 'getApi', entry.extension.getApi);
    }

    hydrateAll(sessionId) {
        for (const entry of this.entries) {
            if (entry.extension && typeof entry.extension.hydrate === 'function') {
                this._invokeSync(entry, 'hydrate', entry.extension.hydrate, [sessionId]);
            }
        }
    }

    // 在宿主事务内被调用：把每个扩展状态写入 store（同一连接 → 原子）。
    persistAll(sessionId) {
        for (const entry of this.entries) {
            if (entry.extension && typeof entry.extension.persist === 'function') {
                this._invokeSync(entry, 'persist', entry.extension.persist, [sessionId]);
            }
        }
    }

    // 脏标记：任一扩展声明自己有未保存变更即为脏。
    isDirty() {
        return this.entries.some((entry) => {
            if (!entry.extension || typeof entry.extension.isDirty !== 'function') return false;
            return this._invokeSync(entry, 'isDirty', entry.extension.isDirty);
        });
    }

    async onBeforeTurn(context) {
        await this._runHook('onBeforeTurn', context);
    }

    async onAfterTurn(context, state) {
        await this._runHook('onAfterTurn', context, state);
    }

    async onToolResult(context, toolCall, result) {
        await this._runHook('onToolResult', context, toolCall, result);
    }

    async onSessionResume(context, info) {
        await this._runHook('onSessionResume', context, info);
    }

    async dispose(context, info = {}) {
        for (const entry of this.entries) {
            if (entry.plugin.onDispose) {
                await this._invoke(entry, 'onDispose', entry.plugin.onDispose, [context, info]);
            }
            if (entry.extension && typeof entry.extension.dispose === 'function') {
                await this._invoke(entry, 'dispose', entry.extension.dispose, [info]);
            }
        }
    }

    // 工具贡献：定义静态可枚举；名称按 owner 命名空间化（D3）；
    // 执行期通过 context.getExtension(owner) 注入 ext，代码内无插件名字面量。
    getTools(context) {
        return this.entries.flatMap((entry) => {
            const tools = entry.plugin.getTools
                ? this._invokeSync(entry, 'getTools', entry.plugin.getTools, [context])
                : (entry.plugin.tools || []);
            return tools.map((tool) => this._wrapTool(tool, entry));
        });
    }

    _wrapTool(tool, entry) {
        const owner = entry.plugin.name;
        const baseName = tool.definition.function.name;
        const namespaced = `${owner}${NAMESPACE_SEPARATOR}${baseName}`;

        return {
            prompt: tool.prompt,
            definition: {
                ...tool.definition,
                function: { ...tool.definition.function, name: namespaced },
            },
            handler: (args, context) => {
                const ext = context && typeof context.getExtension === 'function'
                    ? context.getExtension(owner)
                    : null;
                return this._invoke(entry, 'tool', tool.handler, [args, context, ext], { tool: baseName });
            },
        };
    }

    // 续转守卫贡献：同样在执行期注入 ext，turn-continuation 无需感知 owner。
    getContinuationGuards(context) {
        return this.entries.flatMap((entry) => {
            const guards = entry.plugin.getContinuationGuards
                ? this._invokeSync(entry, 'getContinuationGuards', entry.plugin.getContinuationGuards, [context])
                : (entry.plugin.continuationGuards || []);
            const owner = entry.plugin.name;

            return guards.map((guard) => ({
                shouldContinue: (ctx) => this._invoke(
                    entry, 'guard.shouldContinue', guard.shouldContinue,
                    [ctx, this._extFor(ctx, owner)]
                ),
                buildReminder: (ctx) => this._invoke(
                    entry, 'guard.buildReminder', guard.buildReminder,
                    [ctx, this._extFor(ctx, owner)]
                ),
            }));
        });
    }

    _extFor(ctx, owner) {
        return ctx && typeof ctx.getExtension === 'function' ? ctx.getExtension(owner) : null;
    }

    async _runHook(name, ...args) {
        for (const entry of this.entries) {
            if (entry.plugin[name]) {
                await this._invoke(entry, name, entry.plugin[name], args);
            }
        }
    }

    async _invoke(entry, phase, fn, args = [], details = {}) {
        try {
            return await fn(...args);
        } catch (error) {
            return this._raise(entry, phase, error, details);
        }
    }

    _invokeSync(entry, phase, fn, args = [], details = {}) {
        try {
            const result = fn(...args);
            if (result && typeof result.then === 'function') {
                throw new TypeError(`Plugin "${entry.plugin.name}" phase "${phase}" must be synchronous`);
            }
            return result;
        } catch (error) {
            return this._raise(entry, phase, error, details);
        }
    }

    _raise(entry, phase, error, details = {}) {
        const pluginError = error instanceof PluginError
            ? error
            : new PluginError(entry.plugin.name, phase, error);
        try {
            const result = entry.plugin.onError(pluginError, {
                plugin: entry.plugin.name,
                phase,
                extension: entry.extension,
                ...details,
            });
            if (result && typeof result.then === 'function') {
                throw new TypeError(`Plugin "${entry.plugin.name}" onError() must throw synchronously`);
            }
        } catch (raised) {
            throw raised;
        }
        throw new Error(`Plugin "${entry.plugin.name}" onError() must throw`);
    }
}

// 工具命名空间名 → 基名：`owner__base` 取分隔符之后部分；核心工具无分隔符则原样返回。
// owner 为 kebab-case、base 为 snake_case，二者都不含 `__`，故按首个分隔符切分稳定。
function baseToolName(name) {
    const str = String(name);
    const i = str.indexOf(NAMESPACE_SEPARATOR);
    return i >= 0 ? str.slice(i + NAMESPACE_SEPARATOR.length) : str;
}

module.exports = PluginRegistry;
module.exports.NAMESPACE_SEPARATOR = NAMESPACE_SEPARATOR;
module.exports.baseToolName = baseToolName;
