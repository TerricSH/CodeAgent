// context/ops.js 是 context 私有内核的“消息操作权威”。
// 所有消息写入都经此规范化（created_at / timestamp / finished_at），
// 是消息格式的唯一权威。外部不直接引用本模块（仅 Context 类转发）。
const { cloneMessage } = require('./state');

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

// 递归裁撤：从最旧一条开始丢弃，直到总词元落入 budget。
// 关键安全点：丢弃后不能让开头是悬空的 tool 结果（其 assistant tool_calls
// 被裁掉会导致模型 API 报错），因此一并丢弃开头的孤立 tool 消息。
function trimToBudget(messages, budget, total) {
    if (total === undefined) {
        total = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    }
    if (total <= budget || messages.length === 0) return messages;
    let removed = estimateTokens(messages[0]);
    let rest = messages.slice(1);
    while (rest.length && rest[0].role === 'tool') {
        removed += estimateTokens(rest[0]);
        rest = rest.slice(1);
    }
    return trimToBudget(rest, budget, total - removed);
}

// 上下文管理入口：按 token 预算决定最终发给模型的历史消息。
// 当前仅内嵌纯兜底策略（按词元递归裁旧），后续可在此扩展压缩/重排等。
// system 始终保留且占用预算；若 system 已超预算则历史全裁。
function manageContext(messages, systemMessage, maxTokens, knownTotal) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) return messages;
    const systemTokens = estimateTokens(systemMessage);
    const budget = maxTokens - systemTokens;
    if (budget <= 0) return [];
    return trimToBudget(messages, budget, knownTotal);
}

// 整条子集校验：out 必须是 source 中“原始消息引用”的保序子集。
// 用身份（===）比较，从而禁止拆分/改写单条消息（会破坏上下文理解）。
function isWholeMessageSubset(out, source) {
    if (!Array.isArray(out)) return false;
    let idx = -1;
    for (const m of out) {
        const at = source.indexOf(m, idx + 1);
        if (at === -1) return false;
        idx = at;
    }
    return true;
}

// 可替换裁撤接口：state.contextTrimmer(messages, ctx) => Message[]
//   messages: 全量历史（不含 system）
//   ctx: { systemMessage, maxTokens, estimateTokens, defaultTrim }
// 约定：只能返回 messages 的“整条子集”（保序），不得拆分/改写单条。
// 违反约定或报错 → 一律掉回内置兜底 manageContext。
function runTrimmer(state, systemMessage) {
    // 默认路径裁 state.messages 时，复用运行总数避免全量求和；子集路径则现算。
    const builtin = (msgs) => manageContext(
        msgs,
        systemMessage,
        state.maxContextTokens,
        msgs === state.messages ? totalTokensOf(state) : undefined,
    );
    const custom = typeof state.contextTrimmer === 'function' ? state.contextTrimmer : null;
    if (!custom) return builtin(state.messages);
    try {
        const out = custom(state.messages, {
            systemMessage,
            maxTokens: state.maxContextTokens,
            estimateTokens,
            defaultTrim: builtin,
        });
        if (isWholeMessageSubset(out, state.messages)) return out;
        console.warn('[context] 自定义裁撤返回非整条子集，已回退内置兜底。');
    } catch (err) {
        console.warn(`[context] 自定义裁撤抢错，已回退内置兜底：${err && err.message}`);
    }
    return builtin(state.messages);
}

function getMessages(state, systemMessage) {
    const trimmed = runTrimmer(state, systemMessage);
    return systemMessage ? [systemMessage, ...trimmed] : trimmed;
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
    getMessages,
    manageContext,
    estimateTokens,
    isWholeMessageSubset,
    usage,
    snapshotMessages,
    clear,
};
