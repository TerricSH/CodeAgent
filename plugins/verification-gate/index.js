const path = require('node:path');
const { definePlugin } = require('../define-plugin');
const tool = require('./tool');
const { VerificationGateState } = require('./state');
const { VerificationGateService } = require('./service');
const { loadPromptTemplate } = require('../../prompts/loader');

const NAME = 'verification-gate';
const VERSION = 2;
const TAG = /<verification-gate\b([^>]*)>/gi;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(["'])(.*?)\2/g;
const renderActivePrompt = loadPromptTemplate(path.join(__dirname, 'prompts/active-system.md'));

function findRequiredDirective(text) {
    if (typeof text !== 'string' || !text) return null;
    TAG.lastIndex = 0;
    let tag;
    while ((tag = TAG.exec(text)) !== null) {
        const attributes = {};
        ATTRIBUTE.lastIndex = 0;
        let attribute;
        while ((attribute = ATTRIBUTE.exec(tag[1])) !== null) {
            attributes[attribute[1].toLowerCase()] = attribute[3];
        }
        if (String(attributes.mode || '').toLowerCase() !== 'required') continue;
        return {
            required: true,
            profileId: typeof attributes.profile === 'string' && attributes.profile.trim()
                ? attributes.profile.trim()
                : null,
        };
    }
    return null;
}

function deriveTracePolicy({ basePrompt = '', userContent = '' } = {}) {
    const system = findRequiredDirective(basePrompt);
    if (system) return { [NAME]: { ...system, source: 'system' } };
    const user = findRequiredDirective(userContent);
    if (user) return { [NAME]: { ...user, source: 'user' } };
    return null;
}

module.exports = definePlugin({
    name: NAME,
    scope: 'session',
    tools: [tool],
    capabilities: {
        optional: ['fileSystem', 'commandScope', 'output'],
    },

    onError(error) {
        throw error;
    },

    deriveTracePolicy,

    onBeforeTurn(context) {
        const ext = context.getExtension(NAME);
        const policy = context.taskPolicy?.[NAME];
        if (policy?.required) ext.activatePolicy(policy);
        const record = ext.current();
        if (!record?.required) {
            context.systemPrompt.removeSection(NAME);
            return;
        }
        let planText;
        if (record.override && !record.override.consumed) {
            planText = 'The user approved a one-use cancellation; it will be consumed by Runtime completion authorization.';
        } else if (record.planHash) {
            planText = `Frozen plan: ${record.planHash} (${record.checks.length} checks; authority: ${record.planAuthority.kind}).`;
        } else if (record.profileError) {
            planText = `Required profile error: ${record.profileError}. No effectful work is authorized.`;
        } else {
            planText = 'No approved plan is frozen. A model proposal requires direct user approval before effectful work.';
        }
        const recoveryText = record.degraded
            ? `Prior plugin state could not be restored (${record.degraded.reason}); this Trace is being handled fail-closed with a new binding.`
            : '';
        context.systemPrompt.upsertSection(NAME, renderActivePrompt({
            plan_status: planText,
            recovery_status: recoveryText,
        }));
    },

    onBeforeToolBatch(context, batch) {
        return context.getExtension(NAME)?.beforeToolBatch(batch);
    },

    onBeforeToolExecute(context, tool) {
        return context.getExtension(NAME)?.beforeToolExecute(tool);
    },

    requiresCompletionAuthorization(context) {
        return Boolean(context.getExtension(NAME)?.current()?.required);
    },

    async authorizeTraceCompletion(context) {
        const ext = context.getExtension(NAME);
        const decision = await ext.authorizeCompletion();
        return {
            authorized: decision.authorized,
            status: decision.status,
            reason: decision.reason,
            reminder: decision.authorized ? null : ext.reminder(),
        };
    },

    init(context, { store, config = {}, capabilities = {} } = {}) {
        const state = new VerificationGateState();
        const service = new VerificationGateService(context, state, capabilities, config);
        return {
            getApi: () => service,
            isDirty: () => state.dirty,
            hydrate: async (sessionId) => {
                if (!store || !sessionId) return;
                const raw = await store.read(sessionId);
                if (!raw) return;
                try {
                    const envelope = JSON.parse(raw);
                    if (!envelope || envelope.name !== NAME || envelope.version !== VERSION || !Array.isArray(envelope.data)) {
                        throw new Error(`Invalid ${NAME} state envelope`);
                    }
                    state.restore(envelope.data);
                } catch (error) {
                    state.markDegraded(error);
                    context.recordAudit({
                        eventType: 'verification.state_degraded',
                        actor: NAME,
                        payload: { reason: error.message },
                        indexable: false,
                    });
                }
            },
            persist: async (sessionId, options = {}) => {
                if (!store || !sessionId) return;
                await store.write(sessionId, JSON.stringify({
                    name: NAME,
                    version: VERSION,
                    data: state.list(),
                }), options);
                state.dirty = false;
            },
        };
    },
});
