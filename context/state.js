// context/state.js 是 context 私有内核的“数据形状权威”。
// 只描述上下文状态长什么样，不包含任何操作逻辑或插件状态。

// 纯兜底预算默认值：发给模型时允许的最大输入词元数（含 system）。
// 仅影响传输态；存储态始终保留全量。<=0 或非整数表示不裁。
// 应由上层按实际模型上下文窗口注入（预留输出空间后的输入预算）。
const DEFAULT_MAX_CONTEXT_TOKENS = 32768;

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
        // 历史消息（不含 system）的运行 token 总数：加入时增量累加、裁撤时只减被删部分。
        // null = 尚未计算（如构造时直接载入的历史），首次用时懒计算一次。
        totalTokens: null,
        // 传输态兜底预算：发给模型的最大输入词元数（含 system）。null/<=0 = 不裁。
        maxContextTokens: Number.isInteger(options.maxContextTokens)
            ? options.maxContextTokens
            : DEFAULT_MAX_CONTEXT_TOKENS,
        maxOutputTokens: Number.isInteger(options.maxOutputTokens) && options.maxOutputTokens > 0
            ? options.maxOutputTokens
            : null,
        safetyMargin: Number.isInteger(options.safetyMargin) && options.safetyMargin >= 0
            ? options.safetyMargin
            : null,
        lastPreparation: null,
    };
}

module.exports = {
    createContextState,
    cloneMessage,
    DEFAULT_MAX_CONTEXT_TOKENS,
};
