const SystemPrompt = require('./system-prompt');

class Context {
    constructor(systemPromptText, options = {}) {
        this.systemPrompt = new SystemPrompt(systemPromptText);
        this.sessionId = options.sessionId || null;
        this.metadata = options.metadata || {};
        this.pluginState = Object.create(null);
        this.messages = [];
    }

    setPluginState(name, state) {
        this.pluginState[name] = state;
        return state;
    }

    getPluginState(name) {
        return this.hasPluginState(name) ? this.pluginState[name] : null;
    }

    hasPluginState(name) {
        return Object.prototype.hasOwnProperty.call(this.pluginState, name);
    }

    addUser(content) {
        this.messages.push({ role: 'user', content });
    }

    addAssistant(content) {
        this.messages.push({ role: 'assistant', content });
    }

    addAssistantToolCalls(toolCalls) {
        this.messages.push({
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
        });
    }

    addToolResult(toolCallId, result) {
        this.messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: typeof result === 'string' ? result : JSON.stringify(result),
        });
    }

    getMessages() {
        const sysMsg = this.systemPrompt.toMessage();
        return sysMsg ? [sysMsg, ...this.messages] : this.messages;
    }

    clear() {
        this.messages = [];
        this.pluginState = Object.create(null);
    }
}

module.exports = Context;
