class PluginRegistry {
    constructor(plugins = []) {
        this.entries = [];
        for (const plugin of plugins) {
            this.register(plugin);
        }
    }

    register(plugin, config = {}) {
        if (!plugin || !plugin.name) {
            throw new Error('插件必须提供 name');
        }

        if (config.enabled === false) {
            return null;
        }

        const entry = { plugin, config };
        this.entries.push(entry);
        return plugin;
    }

    list() {
        return this.entries.map(({ plugin }) => plugin);
    }

    get(name) {
        const entry = this.entries.find(({ plugin }) => plugin.name === name);
        return entry ? entry.plugin : null;
    }

    async init(context) {
        for (const { plugin, config } of this.entries) {
            if (plugin.init) {
                await plugin.init(context, config);
            }
        }
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

    getTools(context) {
        return this.entries.flatMap(({ plugin }) => {
            if (plugin.getTools) return plugin.getTools(context);
            return plugin.tools || [];
        });
    }

    getContinuationGuards(context) {
        return this.entries.flatMap(({ plugin }) => {
            if (plugin.getContinuationGuards) return plugin.getContinuationGuards(context);
            return plugin.continuationGuards || [];
        });
    }

    async _runHook(name, ...args) {
        for (const { plugin } of this.entries) {
            if (plugin[name]) {
                await plugin[name](...args);
            }
        }
    }
}

module.exports = PluginRegistry;