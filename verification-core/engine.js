const crypto = require('node:crypto');
const { deepFreeze } = require('./plan');

const STATUSES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE']);

function safeResult(check, result, durationMs) {
    const status = result && STATUSES.includes(result.status) ? result.status : 'INCONCLUSIVE';
    let evidence = {};
    if (result && result.evidence && typeof result.evidence === 'object') {
        try {
            evidence = JSON.parse(JSON.stringify(result.evidence));
        } catch (error) {
            evidence = { invalidEvidence: true, error: error.message };
        }
    }
    return deepFreeze({
        checkId: check.id,
        type: check.type,
        status,
        summary: result && typeof result.summary === 'string'
            ? result.summary
            : 'Provider returned an incomplete result',
        evidence,
        durationMs,
    });
}

class VerificationEngine {
    constructor(registry, options = {}) {
        this.registry = registry;
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    }

    async run(plan, runtime = {}) {
        const attemptId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        this.onEvent('started', { attemptId, planHash: plan.hash, startedAt });
        const checks = [];
        for (const check of plan.checks) {
            const provider = this.registry.get(check.type);
            const start = Date.now();
            let result;
            if (!provider) {
                result = {
                    status: 'INCONCLUSIVE',
                    summary: `Verification provider is unavailable: ${check.type}`,
                    evidence: {},
                };
            } else {
                try {
                    result = await provider.verify(check, runtime);
                } catch (error) {
                    result = {
                        status: 'INCONCLUSIVE',
                        summary: `Verification provider failed: ${error.message}`,
                        evidence: { error: error.message },
                    };
                }
            }
            const normalized = safeResult(check, result, Date.now() - start);
            checks.push(normalized);
            this.onEvent('check_completed', { attemptId, planHash: plan.hash, check: normalized });
        }
        const status = checks.every(check => check.status === 'PASS')
            ? 'PASS'
            : (checks.some(check => check.status === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE');
        const completedAt = new Date().toISOString();
        const outcome = deepFreeze({ attemptId, planHash: plan.hash, status, checks, startedAt, completedAt });
        this.onEvent('completed', outcome);
        return outcome;
    }
}

module.exports = { VerificationEngine, STATUSES, safeResult };
