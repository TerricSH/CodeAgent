const { cloneMessage } = require('./state');

function nowIso() {
    return new Date().toISOString();
}

function withTimestamp(message) {
    if (!message.timestamp) {
        return { ...message, timestamp: nowIso() };
    }

    return message;
}

function setPluginState(state, name, value) {
    state.pluginState[name] = value;
    return value;
}

function hasPluginState(state, name) {
    return Object.prototype.hasOwnProperty.call(state.pluginState, name);
}

function getPluginState(state, name) {
    return hasPluginState(state, name) ? state.pluginState[name] : null;
}

function addMessage(state, message) {
    const normalized = withTimestamp(cloneMessage(message));
    state.messages.push(normalized);
    return normalized;
}

function addUser(state, content) {
    return addMessage(state, { role: 'user', content });
}

function addAssistant(state, content) {
    return addMessage(state, { role: 'assistant', content });
}

function addAssistantToolCalls(state, toolCalls) {
    return addMessage(state, {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
    });
}

function addToolResult(state, toolCallId, result) {
    return addMessage(state, {
        role: 'tool',
        tool_call_id: toolCallId,
        content: typeof result === 'string' ? result : JSON.stringify(result),
    });
}

function getMessages(state, systemMessage) {
    return systemMessage ? [systemMessage, ...state.messages] : state.messages;
}

function snapshotMessages(state) {
    return state.messages.map((message) => cloneMessage(withTimestamp(message)));
}

function clear(state) {
    state.messages = [];
    state.pluginState = Object.create(null);
}

module.exports = {
    setPluginState,
    getPluginState,
    hasPluginState,
    addMessage,
    addUser,
    addAssistant,
    addAssistantToolCalls,
    addToolResult,
    getMessages,
    snapshotMessages,
    clear,
};
