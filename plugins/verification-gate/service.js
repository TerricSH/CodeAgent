const crypto = require('node:crypto');
const {
    VerificationEngine,
    createDefaultVerifierRegistry,
    createPlan,
} = require('../../verification-core');

const APPROVE_OVERRIDE = 'Approve this override';
const APPROVE_PLAN = 'Approve verification plan';
const DENY = 'Deny';

function activeTraceId(context) {
    return context?.activeTaskRef || null;
}

function recordAudit(context, eventType, payload = {}, content = null, options = {}) {
    if (!context || typeof context.recordAudit !== 'function') return null;
    const eventId = crypto.randomUUID();
    const traceId = activeTraceId(context);
    context.recordAudit({
        id: eventId,
        eventType,
        actor: 'verification-gate',
        spanId: payload.attemptId || eventId,
        parentSpanId: traceId,
        content,
        payload,
        forceBlob: options.forceBlob === true,
        indexable: options.indexable !== false,
    });
    return Object.freeze({ sessionId: context.sessionId || null, traceId, eventId });
}

function publicRecord(record, degradation = null) {
    if (!record) return null;
    return {
        traceId: record.traceId,
        required: record.required,
        source: record.source,
        profileId: record.profileId,
        profileError: record.profileError,
        state: record.state,
        planHash: record.planHash,
        planAuthority: record.planAuthority,
        checks: record.plan ? record.plan.checks : [],
        latestAttempt: record.latestAttempt,
        override: record.override ? {
            approvedAt: record.override.approvedAt,
            consumed: record.override.consumed,
        } : null,
        degraded: degradation,
    };
}

function compactCheck(check, evidenceRef) {
    return {
        checkId: check.checkId,
        type: check.type,
        status: check.status,
        summary: check.summary,
        durationMs: check.durationMs,
        evidenceRef: evidenceRef || null,
    };
}

function profileMap(input = {}) {
    if (input == null) return new Map();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('verification-gate profiles must be an object keyed by profile id');
    }
    return new Map(Object.entries(input).map(([id, plan]) => {
        if (!id.trim()) throw new TypeError('Verification profile id must be non-empty');
        return [id, createPlan(plan)];
    }));
}

class VerificationGateService {
    constructor(context, state, capabilities = {}, config = {}) {
        this.context = context;
        this.state = state;
        this.capabilities = capabilities;
        this.registry = createDefaultVerifierRegistry(config.providers || []);
        this.profiles = profileMap(config.profiles || {});
        this.lastDecision = null;
    }

    currentTraceId() {
        return activeTraceId(this.context);
    }

    current() {
        return publicRecord(this.state.get(this.currentTraceId()), this.state.degradation);
    }

    declareRequired(source = 'agent', options = {}) {
        const traceId = this.currentTraceId();
        const existed = Boolean(this.state.get(traceId));
        const record = this.state.require(traceId, source, options);
        if (!existed) {
            recordAudit(this.context, 'verification.required', {
                traceId,
                source,
                profileId: record.profileId,
            });
        }
        return publicRecord(record, this.state.degradation);
    }

    activatePolicy(policy = {}) {
        if (!policy.required) return this.current();
        const traceId = this.currentTraceId();
        const existed = Boolean(this.state.get(traceId));
        const record = this.state.require(traceId, policy.source || 'system', {
            profileId: policy.profileId || null,
        });
        if (!existed) {
            recordAudit(this.context, 'verification.required', {
                traceId,
                source: record.source,
                profileId: record.profileId,
            });
        }
        if (!record.plan && record.profileId && !record.profileError) {
            try {
                this.bindProfile(record.profileId);
            } catch (error) {
                this.state.setProfileError(record.traceId, error.message);
                recordAudit(this.context, 'verification.profile_unavailable', {
                    traceId: record.traceId,
                    profileId: record.profileId,
                    code: error.code || 'VERIFICATION_PROFILE_UNAVAILABLE',
                });
            }
        }
        return publicRecord(record, this.state.degradation);
    }

    _freeze(plan, authority) {
        const traceId = this.currentTraceId();
        const record = this.state.freezePlan(traceId, plan, authority);
        recordAudit(this.context, 'verification.plan_frozen', {
            traceId,
            planHash: record.planHash,
            checkCount: record.plan.checks.length,
            authority: record.planAuthority,
        });
        return publicRecord(record, this.state.degradation);
    }

    bindProfile(profileId) {
        const plan = this.profiles.get(profileId);
        if (!plan) {
            const error = new Error(`Required verification profile is unavailable: ${profileId}`);
            error.code = 'VERIFICATION_PROFILE_UNAVAILABLE';
            throw error;
        }
        return this._freeze(plan, { kind: 'trusted-profile', id: profileId });
    }

    bindTrustedPlan(plan, authority = {}) {
        if (authority.kind !== 'host') {
            throw new TypeError('Direct plan binding is reserved for the host');
        }
        return this._freeze(plan, { kind: 'host', id: authority.id || null });
    }

    async proposePlan(input) {
        const record = this.state.get(this.currentTraceId());
        if (!record?.required) throw new Error('Strong verification is not required for this Trace');
        if (record.plan) throw new Error('Verification plan is already frozen and cannot be changed');
        if (record.profileId) {
            throw new Error(`Trace requires configured verification profile "${record.profileId}"`);
        }
        const plan = createPlan(input);
        recordAudit(this.context, 'verification.plan_proposed', {
            traceId: record.traceId,
            planHash: plan.hash,
            checkCount: plan.checks.length,
        }, JSON.stringify(plan.checks), { forceBlob: true, indexable: false });
        const collect = this.capabilities.output?.prompt?.collect;
        if (typeof collect !== 'function') {
            recordAudit(this.context, 'verification.plan_rejected', {
                traceId: record.traceId,
                planHash: plan.hash,
                reason: 'Interactive approval is unavailable',
            });
            return { approved: false, reason: 'Interactive approval is unavailable', planHash: plan.hash };
        }
        const answer = await collect({
            text: `Approve the verification plan for Trace ${record.traceId}?`,
            intro: `Plan hash: ${plan.hash}\nChecks:\n${JSON.stringify(plan.checks, null, 2)}`,
            options: [APPROVE_PLAN, DENY],
            allowFreeform: false,
            index: 1,
            total: 1,
        });
        if (answer !== APPROVE_PLAN) {
            recordAudit(this.context, 'verification.plan_rejected', {
                traceId: record.traceId,
                planHash: plan.hash,
                reason: 'User did not approve',
            });
            return { approved: false, reason: 'User did not approve', planHash: plan.hash };
        }
        const gate = this._freeze(plan, {
            kind: 'user-approved',
            id: null,
            approvedAt: new Date().toISOString(),
        });
        return { approved: true, gate };
    }

    status() {
        return this.current();
    }

    async verify() {
        const traceId = this.currentTraceId();
        const record = this.state.get(traceId);
        if (!record?.plan) {
            const reason = record?.profileError || 'A frozen verification plan is required';
            const decision = { authorized: false, status: 'INCONCLUSIVE', reason, outcome: null };
            this.lastDecision = decision;
            return decision;
        }
        this.state.beginVerification(traceId);
        const evidenceRefs = new Map();
        const engine = new VerificationEngine(this.registry, {
            onEvent: (name, payload) => {
                if (name === 'started') {
                    recordAudit(this.context, 'verification.started', { traceId, ...payload });
                }
                if (name === 'check_completed') {
                    const reference = recordAudit(this.context, 'verification.check_completed', {
                        traceId,
                        attemptId: payload.attemptId,
                        planHash: payload.planHash,
                        checkId: payload.check.checkId,
                        provider: payload.check.type,
                        status: payload.check.status,
                        summary: payload.check.summary,
                        durationMs: payload.check.durationMs,
                    }, JSON.stringify(payload.check.evidence), { forceBlob: true, indexable: false });
                    evidenceRefs.set(payload.check.checkId, reference);
                }
            },
        });
        const outcome = await engine.run(record.plan, {
            commandScope: this.capabilities.commandScope,
            fileSystem: this.capabilities.fileSystem,
        });
        const compact = {
            attemptId: outcome.attemptId,
            planHash: outcome.planHash,
            status: outcome.status,
            checks: outcome.checks.map(check => compactCheck(check, evidenceRefs.get(check.checkId))),
            startedAt: outcome.startedAt,
            completedAt: outcome.completedAt,
            auditRef: null,
        };
        compact.auditRef = recordAudit(this.context, 'verification.completed', {
            traceId,
            attemptId: compact.attemptId,
            planHash: compact.planHash,
            status: compact.status,
            checks: compact.checks,
            startedAt: compact.startedAt,
            completedAt: compact.completedAt,
        });
        this.state.finishVerification(traceId, compact);
        const decision = {
            authorized: outcome.status === 'PASS',
            status: outcome.status,
            reason: outcome.status === 'PASS' ? 'All verification checks passed' : 'Verification did not pass',
            outcome: compact,
        };
        this.lastDecision = decision;
        return decision;
    }

    async authorizeCompletion() {
        const record = this.state.get(this.currentTraceId());
        if (!record?.required) {
            this.lastDecision = { authorized: true, status: 'NOT_REQUIRED', reason: 'Verification is not required' };
            return this.lastDecision;
        }
        if (this.state.consumeOverride(record.traceId)) {
            this.lastDecision = { authorized: true, status: 'OVERRIDDEN', reason: 'User-approved override consumed' };
            recordAudit(this.context, 'verification.completion_authorized', {
                traceId: record.traceId,
                planHash: record.planHash,
                status: 'OVERRIDDEN',
            });
            return this.lastDecision;
        }
        const decision = await this.verify();
        recordAudit(this.context, decision.authorized
            ? 'verification.completion_authorized'
            : 'verification.completion_blocked', {
            traceId: record.traceId,
            planHash: record.planHash,
            status: decision.status,
            attemptId: decision.outcome?.attemptId || null,
        });
        return decision;
    }

    beforeToolBatch(batch = []) {
        const record = this.state.get(this.currentTraceId());
        if (!record?.required || record.plan || this.state.hasUsableOverride(record.traceId)) return;
        if (!batch.some(tool => !['read', 'control'].includes(tool?.effects))) return;
        const error = new Error('Strong verification requires an approved frozen plan before an effectful tool batch may run');
        error.code = 'VERIFICATION_PLAN_REQUIRED';
        throw error;
    }

    beforeToolExecute(tool) {
        const record = this.state.get(this.currentTraceId());
        if (!record?.required || record.plan || this.state.hasUsableOverride(record.traceId)) return;
        if (tool?.effects === 'read' || tool?.effects === 'control') return;
        const error = new Error('Strong verification requires an approved frozen plan before effectful tools may run');
        error.code = 'VERIFICATION_PLAN_REQUIRED';
        throw error;
    }

    async requestOverride(reason) {
        const record = this.state.get(this.currentTraceId());
        if (!record?.required) throw new Error('Strong verification is not required for this Trace');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('Override reason is required');
        recordAudit(this.context, 'verification.override_requested', {
            traceId: record.traceId,
            planHash: record.planHash,
            reason: reason.trim(),
        });
        const collect = this.capabilities.output?.prompt?.collect;
        if (typeof collect !== 'function') {
            recordAudit(this.context, 'verification.override_denied', {
                traceId: record.traceId,
                planHash: record.planHash,
                reason: 'Interactive approval is unavailable',
            });
            return { approved: false, reason: 'Interactive approval is unavailable' };
        }
        const answer = await collect({
            text: `Cancel strong verification for Trace ${record.traceId}?`,
            intro: `Plan: ${record.planHash || 'not bound'}\nReason: ${reason.trim()}`,
            options: [APPROVE_OVERRIDE, DENY],
            allowFreeform: false,
            index: 1,
            total: 1,
        });
        if (answer !== APPROVE_OVERRIDE) {
            recordAudit(this.context, 'verification.override_denied', {
                traceId: record.traceId,
                planHash: record.planHash,
                reason: 'User did not approve',
            });
            return { approved: false, reason: 'User did not approve' };
        }
        this.state.override(record.traceId, reason.trim());
        recordAudit(this.context, 'verification.override_approved', {
            traceId: record.traceId,
            planHash: record.planHash,
            reason: reason.trim(),
        });
        return { approved: true, traceId: record.traceId, planHash: record.planHash };
    }

    reminder() {
        const record = this.state.get(this.currentTraceId());
        if (!record?.plan) {
            const detail = record?.profileError
                ? ` ${record.profileError}.`
                : ' Propose a deterministic plan and obtain explicit user approval first.';
            return `Strong verification is active but no approved plan is frozen.${detail}`;
        }
        const decision = this.lastDecision;
        if (!decision || decision.authorized) return null;
        const failures = decision.outcome?.checks
            ?.filter(check => check.status !== 'PASS')
            .map(check => `- [${check.status}] ${check.checkId}: ${check.summary}`)
            .join('\n');
        return [
            `Strong verification blocked completion with ${decision.status}.`,
            failures || decision.reason,
            'Fix the implementation and try again. Only an explicitly user-approved override may cancel this gate.',
        ].join('\n');
    }
}

module.exports = {
    VerificationGateService,
    activeTraceId,
    publicRecord,
    recordAudit,
    APPROVE_OVERRIDE,
    APPROVE_PLAN,
    DENY,
};
