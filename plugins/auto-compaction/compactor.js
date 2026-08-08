const path = require('node:path');
const { loadPromptTemplate } = require('../../prompts/loader');

const renderSummarySystem = loadPromptTemplate(path.join(__dirname, 'prompts', 'summary-system.md'));
const renderSummaryUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'summary-user.md'));
const renderPreviousSummary = loadPromptTemplate(path.join(__dirname, 'prompts', 'previous-summary.md'));
const renderSummaryOverlay = loadPromptTemplate(path.join(__dirname, 'prompts', 'summary-overlay.md'));

function serializeForSummary(messages) {
    return messages.map((message) => {
        if (message.role === 'tool') {
            const body = typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content);
            return `[工具结果] ${body}`;
        }
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            const calls = message.tool_calls
                .map(call => call.function && call.function.name)
                .filter(Boolean)
                .join(', ');
            const text = typeof message.content === 'string' && message.content
                ? `${message.content} `
                : '';
            return `[助手] ${text}（调用工具：${calls}）`;
        }
        const role = message.role === 'user'
            ? '用户'
            : (message.role === 'assistant' ? '助手' : message.role);
        return `${role}: ${typeof message.content === 'string' ? message.content : ''}`;
    }).join('\n');
}

function buildSummaryRequest(messages, maxChars) {
    const transcript = serializeForSummary(messages);
    return [
        { role: 'system', content: renderSummarySystem({ maxChars }) },
        { role: 'user', content: renderSummaryUser({ transcript }) },
    ];
}

function formatSummaryContent(text) {
    return renderSummaryOverlay({ summary: text });
}

class Compactor {
    constructor(model, config = {}) {
        this.model = model && typeof model.complete === 'function' ? model : null;
        this.triggerRatio = numberOr(config.triggerRatio, 0.65);
        this.keepRecentCount = intOr(config.keepRecentCount, 10);
        this.minCompactCount = intOr(config.minCompactCount, 6);
        this.recompactStep = intOr(config.recompactStep, 8);
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
        if (!this.activeSummary) return;
        const existing = this.activeSummary.cacheNodeId
            ? context.cache.entries.find(entry => entry.id === this.activeSummary.cacheNodeId)
            : null;
        if (existing) {
            if (existing.resident) context.touch(existing.id, 'compaction-summary-used');
            return;
        }
        const entry = context.load({
            role: 'system',
            content: formatSummaryContent(this.activeSummary.text),
            kind: 'summary',
            sourceRef: `compaction:${context.sessionId}:${this.version}`,
            metadata: { sourceNodeIds: this.activeSummary.sourceNodeIds || [] },
        });
        this.activeSummary.cacheNodeId = entry.id;
    }

    schedule(context) {
        if (!this.model || this.disposed || this.building) return;

        const usage = context.usage();
        if (!usage.limit || usage.used < usage.limit * this.triggerRatio) return;

        const entries = context.cache.entries
            .filter(entry => entry.resident && !entry.required && entry.kind !== 'summary')
            .sort((left, right) => left.sequence - right.sequence);
        const selected = entries.slice(0, Math.max(0, entries.length - this.keepRecentCount));
        if (selected.length < this.minCompactCount) return;
        const sourceNodeIds = selected.map(entry => entry.id);
        if (this.activeSummary && sourceNodeIds.length < this.recompactStep) return;

        const snapshot = selected.flatMap(entry => entry.messages);
        const source = this.activeSummary
            ? [{
                role: 'assistant',
                content: renderPreviousSummary({ summary: this.activeSummary.text }),
            }, ...snapshot]
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
                    sourceNodeIds,
                    generatedAt: new Date().toISOString(),
                };
                const summaryEntry = context.load({
                    role: 'system',
                    content: formatSummaryContent(this.activeSummary.text),
                    kind: 'summary',
                    sourceRef: `compaction:${context.sessionId}:${this.version}`,
                    metadata: { sourceNodeIds },
                });
                this.activeSummary.cacheNodeId = summaryEntry.id;
                for (const nodeId of sourceNodeIds) context.evict(nodeId, 'compressed-to-summary');
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
