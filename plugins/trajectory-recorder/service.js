const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_VERSION = 1;

function cloneJson(value) {
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

function truncate(value, maxChars) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text || text.length <= maxChars) return text || '';
    return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function lastUserMessage(context) {
    const messages = context && context.messages ? context.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user') {
            return {
                index,
                content: cloneJson(messages[index].content),
                createdAt: messages[index].created_at || null,
            };
        }
    }
    return { index: null, content: null, createdAt: null };
}

class TrajectoryRecorder {
    constructor(sessionId, config = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.maxTrajectories = Number.isInteger(config.maxTrajectories) && config.maxTrajectories > 0
            ? config.maxTrajectories
            : 200;
        this.maxResultChars = Number.isInteger(config.maxResultChars) && config.maxResultChars > 0
            ? config.maxResultChars
            : 16000;
        this.exportRoot = path.resolve(
            config.exportRoot || path.join(process.cwd(), '.code', 'rl', 'trajectories')
        );
        this.trajectories = [];
        this.active = null;
        this.dirty = false;
    }

    begin(context) {
        if (this.active) return this.active;
        const input = lastUserMessage(context);
        this.active = {
            id: crypto.randomUUID(),
            sessionId: this.sessionId,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            input,
            toolCalls: [],
            rewards: [],
            reward: 0,
            finalReply: null,
        };
        this.dirty = true;
        return this.active;
    }

    recordTool(context, toolCall = {}, result) {
        const active = this.begin(context);
        active.toolCalls.push({
            id: toolCall.id || null,
            name: toolCall.name || null,
            arguments: cloneJson(toolCall.arguments),
            result: truncate(result, this.maxResultChars),
            recordedAt: new Date().toISOString(),
        });
        this.dirty = true;
    }

    addReward(context, signal = {}) {
        const active = this.begin(context);
        const value = Number(signal.value);
        if (!Number.isFinite(value)) return;
        active.rewards.push({
            value,
            source: signal.source || 'unknown',
            reason: signal.reason || null,
            metadata: cloneJson(signal.metadata),
            recordedAt: signal.recordedAt || new Date().toISOString(),
        });
        active.reward += value;
        this.dirty = true;
    }

    finalize(context, state = {}) {
        const active = this.begin(context);
        active.finalReply = truncate(state.reply || '', this.maxResultChars);
        active.finishedAt = new Date().toISOString();
        this.trajectories.push(active);
        if (this.trajectories.length > this.maxTrajectories) {
            this.trajectories.splice(0, this.trajectories.length - this.maxTrajectories);
        }
        this.active = null;
        this.dirty = true;
        return active;
    }

    list(options = {}) {
        const limit = Math.min(Math.max(1, Number(options.limit) || 20), 100);
        return this.trajectories.slice(-limit).reverse().map((item) => ({
            id: item.id,
            startedAt: item.startedAt,
            finishedAt: item.finishedAt,
            toolCallCount: item.toolCalls.length,
            reward: item.reward,
            input: item.input.content,
        }));
    }

    getTrajectories(options = {}) {
        const limit = Math.min(
            Math.max(1, Number(options.limit) || this.maxTrajectories),
            this.maxTrajectories
        );
        return cloneJson(this.trajectories.slice(-limit));
    }

    exportJsonl() {
        fs.mkdirSync(this.exportRoot, { recursive: true });
        const safeSession = this.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const file = path.join(this.exportRoot, `${safeSession}.jsonl`);
        const content = this.trajectories.map((item) => JSON.stringify(item)).join('\n');
        fs.writeFileSync(file, content ? `${content}\n` : '', 'utf8');
        return { file, count: this.trajectories.length };
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || envelope.version !== STATE_VERSION || !envelope.data) {
            throw new Error('Invalid trajectory-recorder state envelope');
        }
        this.trajectories = Array.isArray(envelope.data.trajectories)
            ? envelope.data.trajectories.slice(-this.maxTrajectories)
            : [];
        this.active = envelope.data.active || null;
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            name: 'trajectory-recorder',
            version: STATE_VERSION,
            data: {
                trajectories: this.trajectories,
                active: this.active,
            },
        });
    }
}

module.exports = { TrajectoryRecorder, truncate, lastUserMessage };
