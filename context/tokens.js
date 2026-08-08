// context/tokens.js 是 context 私有内核的“词元估算权威”。
// 纯启发式估算 + 只读用量快照，无 tokenizer 依赖。外部不直接引用（仅经 Context 转发）。

// 粗略词元估算：无需引入 tokenizer 依赖的轻量启发式。
// CJK 字符约 1 token/字，其余字符约 0.25 token/字，加每条结构开销。
// 偏保守（宁可高估），以免实际超出模型上下文窗口。
// 性能：消息写入后不可变，按消息身份缓存估算值（WeakMap），避免每轮重算。
const _tokenCache = new WeakMap();
function estimateTokens(message) {
    if (!message) return 0;
    const cached = _tokenCache.get(message);
    if (cached !== undefined) return cached;
    let text = '';
    if (typeof message.content === 'string') text += message.content;
    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            text += (tc.function && tc.function.name) || '';
            text += (tc.function && tc.function.arguments) || '';
        }
    }
    let tokens = 4; // 每条消息的角色/分隔结构开销
    for (const ch of text) {
        tokens += /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 1 : 0.25;
    }
    const result = Math.ceil(tokens);
    _tokenCache.set(message, result);
    return result;
}

function estimateTextTokens(value) {
    return estimateTokens({
        content: typeof value === 'string' ? value : JSON.stringify(value),
    });
}

function estimateToolsTokens(tools = []) {
    if (!Array.isArray(tools) || tools.length === 0) return 0;
    return estimateTextTokens(tools) + (tools.length * 8);
}

function estimateRequestTokens(messages = [], tools = []) {
    const messageTokens = Array.isArray(messages)
        ? messages.reduce((sum, message) => sum + estimateTokens(message), 0)
        : 0;
    return messageTokens + estimateToolsTokens(tools) + 16;
}

// 历史消息（不含 system）的运行 token 总数：null 时懒计算一次，之后由 add/clear 增量维护。
function totalTokensOf(state) {
    if (state.totalTokens == null) {
        state.totalTokens = state.messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    }
    return state.totalTokens;
}

// 只读用量快照：估算已用 token（历史 + system）、限额、剩余、明细。供 UI 实时显示。
// 所有值为“估算”（与裁撤同源的启发式），非精确计费值。
function usage(state, systemMessage) {
    const history = totalTokensOf(state);
    const system = estimateTokens(systemMessage);
    const limit = (Number.isInteger(state.maxContextTokens) && state.maxContextTokens > 0)
        ? state.maxContextTokens
        : null;
    const used = history + system;
    return {
        used,
        history,
        system,
        limit,
        remaining: limit != null ? Math.max(0, limit - used) : null,
        messageCount: state.messages.length,
    };
}

module.exports = {
    estimateTokens,
    estimateTextTokens,
    estimateToolsTokens,
    estimateRequestTokens,
    totalTokensOf,
    usage,
};
