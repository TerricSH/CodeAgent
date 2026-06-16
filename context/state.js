function cloneMessage(message) {
    return {
        ...message,
        tool_calls: Array.isArray(message.tool_calls)
            ? message.tool_calls.map((call) => ({
                ...call,
                function: call.function ? { ...call.function } : call.function,
            }))
            : message.tool_calls,
        metadata: message.metadata && typeof message.metadata === 'object'
            ? { ...message.metadata }
            : message.metadata,
    };
}

function createContextState(options = {}) {
    return {
        sessionId: options.sessionId || null,
        metadata: options.metadata && typeof options.metadata === 'object'
            ? { ...options.metadata }
            : {},
        pluginState: Object.create(null),
        messages: Array.isArray(options.messages)
            ? options.messages.map(cloneMessage)
            : [],
    };
}

module.exports = {
    createContextState,
    cloneMessage,
};
