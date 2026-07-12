function validatePlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') throw new TypeError('Plugin must be an object');
    if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
        throw new TypeError('Plugin must provide a non-empty name');
    }
    if (typeof plugin.init !== 'function') {
        throw new TypeError(`Plugin "${plugin.name}" must implement init()`);
    }
    if (typeof plugin.onError !== 'function') {
        throw new TypeError(`Plugin "${plugin.name}" must implement onError()`);
    }
    return plugin;
}

function definePlugin(plugin) {
    return Object.freeze(validatePlugin(plugin));
}

module.exports = { definePlugin, validatePlugin };
