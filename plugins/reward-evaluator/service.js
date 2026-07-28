const STATE_VERSION = 1;
const SANDBOX_TOOL = 'docker-sandbox__sandbox_exec';

function parseJson(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

class RewardEvaluator {
    constructor(config = {}) {
        this.passReward = Number.isFinite(config.passReward) ? config.passReward : 1;
        this.failReward = Number.isFinite(config.failReward) ? config.failReward : -1;
        this.timeoutReward = Number.isFinite(config.timeoutReward) ? config.timeoutReward : -1;
        this.maxSignals = Number.isInteger(config.maxSignals) && config.maxSignals > 0
            ? config.maxSignals
            : 500;
        this.signals = [];
        this.dirty = false;
    }

    evaluate(toolCall = {}, result) {
        if (toolCall.name !== SANDBOX_TOOL) return null;
        const args = parseJson(toolCall.arguments) || {};
        if (args.purpose !== 'evaluation') return null;

        const outcome = parseJson(result);
        let value;
        let reason;
        if (!outcome) {
            value = this.failReward;
            reason = 'invalid_sandbox_result';
        } else if (outcome.timedOut) {
            value = this.timeoutReward;
            reason = 'evaluation_timeout';
        } else if (outcome.ok && outcome.exitCode === 0) {
            value = this.passReward;
            reason = 'evaluation_passed';
        } else {
            value = this.failReward;
            reason = 'evaluation_failed';
        }

        const signal = {
            value,
            source: 'docker-sandbox',
            reason,
            metadata: {
                toolCallId: toolCall.id || null,
                exitCode: outcome ? outcome.exitCode : null,
                durationMs: outcome ? outcome.durationMs : null,
            },
            recordedAt: new Date().toISOString(),
        };
        this.signals.push(signal);
        if (this.signals.length > this.maxSignals) {
            this.signals.splice(0, this.signals.length - this.maxSignals);
        }
        this.dirty = true;
        return signal;
    }

    summary() {
        const reward = this.signals.reduce((sum, signal) => sum + signal.value, 0);
        const passed = this.signals.filter((signal) => signal.reason === 'evaluation_passed').length;
        const failed = this.signals.length - passed;
        return { count: this.signals.length, reward, passed, failed };
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || envelope.version !== STATE_VERSION || !Array.isArray(envelope.data)) {
            throw new Error('Invalid reward-evaluator state envelope');
        }
        this.signals = envelope.data.slice(-this.maxSignals);
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            name: 'reward-evaluator',
            version: STATE_VERSION,
            data: this.signals,
        });
    }
}

module.exports = { RewardEvaluator, SANDBOX_TOOL, parseJson };
