// auto-compaction 的核心逻辑：把较早的对话压缩成一条摘要，经 transport overlay 仅作用于传输态。
// 存储态（context 全量历史）始终不动；摘要是派生的传输覆盖，重载后按需重算。

// 把待压缩消息序列化成可读转写，喂给模型做摘要。
function serializeForSummary(messages) {
    return messages.map((m) => {
        if (m.role === 'tool') {
            const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return `[工具结果] ${body}`;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            const calls = m.tool_calls.map((tc) => tc.function && tc.function.name).filter(Boolean).join(', ');
            const text = typeof m.content === 'string' && m.content ? `${m.content} ` : '';
            return `[助手] ${text}（调用工具：${calls}）`;
        }
        const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '助手' : m.role);
        return `${role}: ${typeof m.content === 'string' ? m.content : ''}`;
    }).join('\n');
}

// 构造摘要请求消息（纯文本进、纯文本出；不带工具）。
function buildSummaryRequest(messages, maxChars) {
    const transcript = serializeForSummary(messages);
    return [
        {
            role: 'system',
            content: [
                '你是对话压缩器。把下面较早的对话压缩成简洁的中文要点。',
                '务必保留：关键事实、已做的决定、未完成事项、涉及的文件/标识符/数值。',
                `丢弃寒暄与冗余。输出不超过约 ${maxChars} 字，用要点列表，不要前后缀解释。`,
            ].join('\n'),
        },
        {
            role: 'user',
            content: `以下是需要压缩的较早对话：\n\n${transcript}`,
        },
    ];
}

function formatSummaryContent(text) {
    return `「之前对话的摘要（自动压缩，仅供上下文参考）」：\n${text}`;
}

class Compactor {
    constructor(model, config = {}) {
        // 无模型则降级为“从不压缩”（不报错、不影响主流程）。
        this.model = model && typeof model.complete === 'function' ? model : null;
        // 触发阈值：已用/限额 达到此比例才压缩。
        this.triggerRatio = numberOr(config.triggerRatio, 0.65);
        // 保留最近多少条消息逐字不压缩。
        this.keepRecentCount = intOr(config.keepRecentCount, 10);
        // 可压缩消息数低于此值则不值得压缩。
        this.minCompactCount = intOr(config.minCompactCount, 6);
        // 距上次摘要至少新增这么多可覆盖消息才重算，避免每轮都调模型。
        this.recompactStep = intOr(config.recompactStep, 8);
        // 摘要长度上限（提示模型用）。
        this.maxSummaryChars = intOr(config.maxSummaryChars, 800);
        this.activeSummary = null;
        this.building = null;
        this.pendingError = null;
        this.version = 0;
        this.dirty = false;
        this.disposed = false;
    }

    hydrate(raw) {
        if (!raw) return;
        const state = JSON.parse(raw);
        if (!state || state.version !== 1) throw new Error('Invalid auto-compaction state');
        this.activeSummary = state.activeSummary || null;
        this.version = Number(state.summaryVersion) || 0;
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            version: 1,
            summaryVersion: this.version,
            activeSummary: this.activeSummary,
        });
    }

    apply(context) {
        if (this.pendingError) {
            const error = this.pendingError;
            this.pendingError = null;
            throw error;
        }
        if (!this.activeSummary) {
            context.setTransportOverlay('auto-compaction', null);
            return;
        }
        context.setTransportOverlay('auto-compaction', {
            priority: 40,
            version: this.version,
            coverEnd: this.activeSummary.coverEnd,
            messages: [formatSummaryContent(this.activeSummary.text)],
        });
    }

    schedule(context) {
        if (!this.model || this.disposed || this.building) return;

        const usage = context.usage();
        if (!usage.limit) return;
        if (usage.used < usage.limit * this.triggerRatio) return;

        const messages = context.messages;
        const coverEnd = messages.length - this.keepRecentCount;
        if (coverEnd < this.minCompactCount) return;

        const previousEnd = this.activeSummary ? this.activeSummary.coverEnd : 0;
        if (coverEnd <= previousEnd) return;
        if (this.activeSummary && coverEnd - previousEnd < this.recompactStep) return;

        const snapshot = messages.slice(previousEnd, coverEnd);
        const source = this.activeSummary
            ? [{ role: 'assistant', content: `Previous rolling summary:\n${this.activeSummary.text}` }, ...snapshot]
            : snapshot;
        const baseVersion = this.version;
        const sessionId = context.sessionId;

        this.building = this.model.complete(buildSummaryRequest(source, this.maxSummaryChars))
            .then((text) => {
                if (this.disposed || context.sessionId !== sessionId || this.version !== baseVersion) return;
                if (!text || !text.trim()) return;
                this.version += 1;
                this.activeSummary = {
                    text: text.trim(),
                    coverEnd,
                    generatedAt: new Date().toISOString(),
                };
                this.dirty = true;
            })
            .catch((error) => {
                if (!this.disposed) this.pendingError = error;
            })
            .finally(() => {
                this.building = null;
            });
    }

    dispose() {
        this.disposed = true;
    }
}

function numberOr(value, fallback) {
    return typeof value === 'number' && value > 0 ? value : fallback;
}

function intOr(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = { Compactor, buildSummaryRequest, serializeForSummary, formatSummaryContent };
