const { createPlan } = require('../../verification-core');

const RECORD_STATES = Object.freeze([
    'required', 'planned', 'verifying', 'passed', 'failed', 'inconclusive', 'overridden',
]);
const PLAN_AUTHORITIES = Object.freeze(['trusted-profile', 'user-approved', 'host']);
const MAX_RECORDS = 32;
const SOURCE_PRIORITY = Object.freeze({ agent: 1, user: 2, system: 3, host: 4 });

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function gateKey(record) {
    return record.planHash || `unbound:${record.traceId}:${record.profileId || 'none'}`;
}

function normalizeAuthority(authority) {
    if (!authority || typeof authority !== 'object' || !PLAN_AUTHORITIES.includes(authority.kind)) {
        throw new TypeError('Verification plans require a trusted profile, explicit user approval, or host authority');
    }
    return {
        kind: authority.kind,
        id: typeof authority.id === 'string' && authority.id ? authority.id : null,
        approvedAt: authority.approvedAt || null,
    };
}

function validateAttempt(attempt) {
    if (attempt == null) return null;
    if (!attempt || typeof attempt !== 'object' || typeof attempt.attemptId !== 'string') {
        throw new TypeError('Invalid compact verification attempt');
    }
    if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(attempt.status) || !Array.isArray(attempt.checks)) {
        throw new TypeError('Invalid compact verification attempt status');
    }
    for (const check of attempt.checks) {
        if (!check || typeof check.checkId !== 'string' || !['PASS', 'FAIL', 'INCONCLUSIVE'].includes(check.status)) {
            throw new TypeError('Invalid compact verification check');
        }
        if (Object.prototype.hasOwnProperty.call(check, 'evidence')) {
            throw new TypeError('Verification evidence must not be persisted in extension state');
        }
    }
    return clone(attempt);
}

class VerificationGateState {
    constructor() {
        this.records = new Map();
        this.degradation = null;
        this.dirty = false;
    }

    get(traceId) {
        return traceId ? this.records.get(traceId) || null : null;
    }

    markDegraded(error) {
        this.degradation = {
            reason: error instanceof Error ? error.message : String(error),
            detectedAt: new Date().toISOString(),
        };
    }

    prune(keepTraceId = null) {
        if (this.records.size < MAX_RECORDS) return;
        const removable = [...this.records.values()]
            .filter(record => record.traceId !== keepTraceId && record.state !== 'verifying')
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
        while (this.records.size >= MAX_RECORDS && removable.length > 0) {
            this.records.delete(removable.shift().traceId);
        }
    }

    require(traceId, source = 'agent', options = {}) {
        if (!traceId) throw new Error('An active Trace is required');
        const existing = this.get(traceId);
        if (existing) {
            const incomingPriority = SOURCE_PRIORITY[source] || 0;
            const currentPriority = SOURCE_PRIORITY[existing.source] || 0;
            if (incomingPriority > currentPriority) existing.source = source;
            if (options.profileId) {
                if (existing.profileId && existing.profileId !== options.profileId) {
                    throw new Error('The required verification profile cannot be changed');
                }
                if (!existing.plan) existing.profileId = options.profileId;
            }
            return existing;
        }
        this.prune(traceId);
        const record = {
            traceId,
            required: true,
            source,
            profileId: options.profileId || null,
            profileError: null,
            plan: null,
            planHash: null,
            planAuthority: null,
            state: 'required',
            latestAttempt: null,
            override: null,
            createdAt: new Date().toISOString(),
            frozenAt: null,
            completedAt: null,
        };
        this.records.set(traceId, record);
        this.dirty = true;
        return record;
    }

    setProfileError(traceId, message) {
        const record = this.get(traceId);
        if (!record) throw new Error('Unknown verification Trace');
        record.profileError = String(message);
        this.dirty = true;
        return record;
    }

    freezePlan(traceId, input, authority) {
        const record = this.get(traceId);
        if (!record || !record.required) throw new Error('Strong verification is not required for this Trace');
        if (record.plan) throw new Error('Verification plan is already frozen and cannot be changed');
        const plan = createPlan(input);
        record.plan = plan;
        record.planHash = plan.hash;
        record.planAuthority = normalizeAuthority(authority);
        record.profileError = null;
        record.state = 'planned';
        record.frozenAt = new Date().toISOString();
        this.dirty = true;
        return record;
    }

    beginVerification(traceId) {
        const record = this.get(traceId);
        if (!record?.plan) throw new Error('A frozen verification plan is required');
        record.state = 'verifying';
        this.dirty = true;
        return record;
    }

    finishVerification(traceId, compactOutcome) {
        const record = this.get(traceId);
        if (!record) throw new Error('Unknown verification Trace');
        record.latestAttempt = validateAttempt(compactOutcome);
        record.state = compactOutcome.status === 'PASS'
            ? 'passed'
            : (compactOutcome.status === 'FAIL' ? 'failed' : 'inconclusive');
        record.completedAt = compactOutcome.completedAt;
        this.dirty = true;
        return record;
    }

    override(traceId, reason) {
        const record = this.get(traceId);
        if (!record?.required) throw new Error('Strong verification is not required for this Trace');
        record.override = {
            traceId,
            gateKey: gateKey(record),
            reason,
            approvedAt: new Date().toISOString(),
            consumed: false,
        };
        record.state = 'overridden';
        this.dirty = true;
        return record;
    }

    consumeOverride(traceId) {
        const record = this.get(traceId);
        const override = record?.override;
        if (!override || override.consumed || override.gateKey !== gateKey(record)) return false;
        override.consumed = true;
        this.dirty = true;
        return true;
    }

    hasUsableOverride(traceId) {
        const record = this.get(traceId);
        const override = record?.override;
        return Boolean(override && !override.consumed && override.gateKey === gateKey(record));
    }

    list() {
        return [...this.records.values()]
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
            .slice(-MAX_RECORDS)
            .map(clone);
    }

    restore(records) {
        if (!Array.isArray(records)) throw new TypeError('Verification state data must be an array');
        const restored = new Map();
        for (const raw of records.slice(-MAX_RECORDS)) {
            if (!raw || typeof raw.traceId !== 'string' || !raw.required || !RECORD_STATES.includes(raw.state)) {
                throw new TypeError('Invalid verification state record');
            }
            const record = clone(raw);
            if (record.plan) {
                const plan = createPlan(record.plan);
                if (record.planHash !== plan.hash) throw new Error('Verification plan hash mismatch');
                record.plan = plan;
                record.planHash = plan.hash;
                record.planAuthority = normalizeAuthority(record.planAuthority);
            } else if (record.planHash || record.planAuthority) {
                throw new Error('Verification state contains an incomplete plan binding');
            }
            record.latestAttempt = validateAttempt(record.latestAttempt || null);
            if (record.state === 'verifying') record.state = 'inconclusive';
            restored.set(record.traceId, record);
        }
        this.records = restored;
        this.dirty = false;
    }
}

module.exports = {
    VerificationGateState,
    RECORD_STATES,
    PLAN_AUTHORITIES,
    MAX_RECORDS,
    gateKey,
};
