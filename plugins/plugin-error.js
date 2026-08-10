class PluginError extends Error {
    constructor(plugin, phase, cause) {
        const source = cause instanceof Error ? cause : new Error(String(cause));
        super(`[plugin:${plugin}] ${phase} failed: ${source.message}`, { cause: source });
        this.name = 'PluginError';
        this.plugin = plugin;
        this.phase = phase;
        if (source.code) this.code = source.code;
    }
}

module.exports = PluginError;
