const PluginRegistry = require('../context/plugins');
const taskLedgerPlugin = require('./task-ledger');

const defaultPlugins = [taskLedgerPlugin];

function getPluginConfig(name, options = {}) {
    const pluginOptions = options.plugins || {};
    const config = pluginOptions[name];

    if (config === false) {
        return { enabled: false };
    }

    return config || {};
}

function createDefaultRegistry(options = {}) {
    const registry = new PluginRegistry();

    for (const plugin of defaultPlugins) {
        registry.register(plugin, getPluginConfig(plugin.name, options));
    }

    return registry;
}

module.exports = {
    createDefaultRegistry,
    taskLedgerPlugin,
};