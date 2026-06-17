// context/state.js 是 context 私有内核的“数据形状权威”。
// 只描述上下文状态长什么样，不包含任何操作逻辑或插件状态。
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
        messages: Array.isArray(options.messages)
            ? options.messages.map(cloneMessage)
            : [],
    };
}

module.exports = {
    createContextState,
    cloneMessage,
};
