const PluginRegistry = require('./registry');
const { baseToolName } = PluginRegistry;
const { createScopedStore } = require('../data-layer/repositories/extension-state-repository');
const taskLedgerPlugin = require('./task-ledger');
const verificationGatePlugin = require('./verification-gate');
const askUserPlugin = require('./ask-user');
const workspacePlugin = require('./workspace');
const autoCompactionPlugin = require('./auto-compaction');
const memoryPlugin = require('./memory');
const dockerSandboxPlugin = require('./docker-sandbox');
const PluginError = require('./plugin-error');
const { definePlugin, validatePlugin } = require('./define-plugin');

const defaultPlugins = [
    taskLedgerPlugin,
    verificationGatePlugin,
    askUserPlugin,
    workspacePlugin,
    memoryPlugin,
    autoCompactionPlugin,
    dockerSandboxPlugin,
];

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
        capabilities: options.capabilities || {},
    });

    for (const plugin of defaultPlugins) {
        registry.register(plugin, getPluginConfig(plugin.name, options));
    }

    return registry;
}

module.exports = {
    createDefaultRegistry,
    taskLedgerPlugin,
    verificationGatePlugin,
    askUserPlugin,
    workspacePlugin,
    autoCompactionPlugin,
    memoryPlugin,
    dockerSandboxPlugin,
    PluginError,
    definePlugin,
    validatePlugin,
    baseToolName,
};
