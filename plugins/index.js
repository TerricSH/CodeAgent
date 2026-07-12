const PluginRegistry = require('./registry');
const { baseToolName } = PluginRegistry;
const { createScopedStore } = require('../data-layer/repositories/extension-state-repository');
const taskLedgerPlugin = require('./task-ledger');
const askUserPlugin = require('./ask-user');
const autoCompactionPlugin = require('./auto-compaction');
const memoryPlugin = require('./memory');
const PluginError = require('./plugin-error');
const { definePlugin, validatePlugin } = require('./define-plugin');

const defaultPlugins = [taskLedgerPlugin, askUserPlugin, memoryPlugin, autoCompactionPlugin];

function getPluginConfig(name, options = {}) {
    const pluginOptions = options.plugins || {};
    const config = pluginOptions[name];

    if (config === false) {
        return { enabled: false };
    }

    return config || {};
}

function createDefaultRegistry(options = {}) {
    const registry = new PluginRegistry({
        storeFactory: createScopedStore,
        services: options.services || {},
    });

    for (const plugin of defaultPlugins) {
        registry.register(plugin, getPluginConfig(plugin.name, options));
    }

    return registry;
}

module.exports = {
    createDefaultRegistry,
    taskLedgerPlugin,
    askUserPlugin,
    autoCompactionPlugin,
    memoryPlugin,
    PluginError,
    definePlugin,
    validatePlugin,
    baseToolName,
};
