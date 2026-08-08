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
        if (!usage.limit || usage.used < usage.limit * this.triggerRatio) return;

        const messages = context.messages;
        const coverEnd = messages.length - this.keepRecentCount;
        if (coverEnd < this.minCompactCount) return;

        const previousEnd = this.activeSummary ? this.activeSummary.coverEnd : 0;
        if (coverEnd <= previousEnd) return;
        if (this.activeSummary && coverEnd - previousEnd < this.recompactStep) return;

        const snapshot = messages.slice(previousEnd, coverEnd);
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
