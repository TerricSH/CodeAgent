// context/messages.js 是 context 私有内核的“消息操作权威”。
// 所有消息写入都经此规范化（created_at / timestamp / finished_at），
// 是消息格式的唯一权威。外部不直接引用本模块（仅 Context 类转发）。
const { cloneMessage } = require('./state');
const { estimateTokens } = require('./tokens');

function nowIso() {
    return new Date().toISOString();
}

function normalizeMessage(message) {
    const cloned = cloneMessage(message);
    const createdAt = cloned.created_at || cloned.timestamp || nowIso();

    return {
        ...cloned,
        created_at: createdAt,
        timestamp: cloned.timestamp || createdAt,
        finished_at: cloned.finished_at || null,
    };
}

function addMessage(state, message) {
    const normalized = normalizeMessage(message);
    state.messages.push(normalized);
    // 增量维护运行总数（仅在已初始化时；null 表示待懒计算，交由 totalTokensOf 补齐）。
    if (state.totalTokens != null) state.totalTokens += estimateTokens(normalized);
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

function addToolResult(state, toolCallId, result, options = {}) {
    return addMessage(state, {
        role: 'tool',
        tool_call_id: toolCallId,
        content: typeof result === 'string' ? result : JSON.stringify(result),
        finished_at: options.finishedAt || null,
    });
}

function snapshotMessages(state) {
    return state.messages.map((message) => normalizeMessage(message));
}

function clear(state) {
    state.messages = [];
    state.totalTokens = 0;
}

module.exports = {
    normalizeMessage,
    addMessage,
    addUser,
    addAssistant,
    addAssistantToolCalls,
    addToolResult,
    snapshotMessages,
    clear,
};
