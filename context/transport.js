// context/transport.js 是 context 私有内核的“传输态组装权威”。
// 决定最终发给模型的历史消息：先应用插件登记的传输覆盖（摘要替最旧前缀），再过内置按词元裁撤兜底。
// 存储态始终保留全量；本模块只产出传输态，不改 state.messages。
const { estimateTokens, totalTokensOf } = require('./tokens');

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

// 内置兜底裁撤：按 token 预算决定最终发给模型的历史消息（按词元递归裁旧）。
// 始终作为传输组装的最后一段，保证无论前面覆盖如何加工都不会超预算。
// system 始终保留且占用预算；若 system 已超预算则历史全裁。
function manageContext(messages, systemMessage, maxTokens, knownTotal) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) return messages;
    const systemTokens = estimateTokens(systemMessage);
    const budget = maxTokens - systemTokens;
    if (budget <= 0) return [];
    return trimToBudget(messages, budget, knownTotal);
}

// —— 安全助手 ——
// 安全切点：返回 >= idx 的最小边界，使 messages.slice(boundary) 不以悬空 tool 开头。
// 摘要/丢弃前缀时用它选边界，避免把 assistant.tool_calls 与其 tool 结果切断。
function findSafeBoundary(messages, idx) {
    let boundary = Math.max(0, Math.min(idx, messages.length));
    while (boundary < messages.length && messages[boundary].role === 'tool') boundary += 1;
    return boundary;
}

// 悬空校验：每条 tool 结果的 tool_call_id 必须由前面某条 assistant.tool_calls 声明过。
// 任一 tool 找不到声明它的 assistant → 该计划会让模型 API 报错，判定为非法。
function hasDanglingTool(messages) {
    const declared = new Set();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) declared.add(tc.id);
        }
        if (m.role === 'tool' && !declared.has(m.tool_call_id)) return true;
    }
    return false;
}

function isValidOverlay(overlay) {
    return overlay && overlay.summary && typeof overlay.summary === 'object';
}

// 应用传输覆盖（transport overlay）：把一段最旧前缀替换为一条摘要消息，仅作用于传输态。
// overlay = { summary: Message, coverEnd: number }（coverEnd 为被覆盖的存储索引上界，独占）。
// 安全点：用 findSafeBoundary 收敛切点，避免切断 tool 配对；摘要置于最前。
// 任一非法（缺摘要 / 越界 / 产生悬空 tool）→ 忽略 overlay，回退全量。
function applyOverlay(messages, overlay) {
    if (!isValidOverlay(overlay)) return messages;
    const boundary = findSafeBoundary(messages, overlay.coverEnd || 0);
    if (boundary <= 0) return messages;
    const out = [overlay.summary, ...messages.slice(boundary)];
    if (hasDanglingTool(out)) {
        console.warn('[context] 传输覆盖产生悬空 tool 结果，已忽略本次覆盖。');
        return messages;
    }
    return out;
}

// 传输态组装：先应用插件登记的覆盖（同步、纯数据），再过内置裁撤兜底。
// 覆盖只影响传输态；存储态（state.messages）始终全量。
function buildTransport(state, systemMessage) {
    const overlaid = applyOverlay(state.messages, state.transportOverlay);
    // 未被覆盖改动时复用运行总数，避免全量求和。
    const knownTotal = overlaid === state.messages ? totalTokensOf(state) : undefined;
    return manageContext(overlaid, systemMessage, state.maxContextTokens, knownTotal);
}

function getMessages(state, systemMessage) {
    const trimmed = buildTransport(state, systemMessage);
    return systemMessage ? [systemMessage, ...trimmed] : trimmed;
}

module.exports = {
    trimToBudget,
    manageContext,
    findSafeBoundary,
    hasDanglingTool,
    applyOverlay,
    buildTransport,
    getMessages,
};
