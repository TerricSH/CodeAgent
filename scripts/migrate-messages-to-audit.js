require('dotenv').config();
const Session = require('../session');
const auditRepository = require('../data-layer/repositories/audit-repository');

const LEGACY_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function parseTimestamp(value) {
    if (!value) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function validateLegacySession(session, knownSessionIds = null) {
    const failures = [];
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const declaredCalls = new Map();
    let previousTimestamp = parseTimestamp(session?.startTime);
    let toolCallCount = 0;
    let toolResultCount = 0;

    const addFailure = (code, details = {}) => failures.push({ code, ...details });
    if (!session?.id) addFailure('missing-session-id');
    if (session?.startTime && previousTimestamp == null) {
        addFailure('invalid-session-start-time', { value: session.startTime });
    }
    const endTimestamp = parseTimestamp(session?.endTime);
    if (session?.endTime && endTimestamp == null) {
        addFailure('invalid-session-end-time', { value: session.endTime });
    } else if (previousTimestamp != null && endTimestamp != null && endTimestamp < previousTimestamp) {
        addFailure('session-end-before-start');
    }

    messages.forEach((message, index) => {
        const role = message?.role;
        if (!LEGACY_ROLES.has(role)) addFailure('unsupported-role', { index, role: role || null });

        const rawTimestamp = message?.created_at || message?.timestamp || session?.startTime;
        const timestamp = parseTimestamp(rawTimestamp);
        if (rawTimestamp && timestamp == null) {
            addFailure('invalid-message-time', { index, value: rawTimestamp });
        } else if (timestamp != null) {
            if (previousTimestamp != null && timestamp < previousTimestamp) {
                addFailure('message-time-out-of-order', { index });
            }
            previousTimestamp = Math.max(previousTimestamp ?? timestamp, timestamp);
        }

        const finishedTimestamp = parseTimestamp(message?.finished_at);
        if (message?.finished_at && finishedTimestamp == null) {
            addFailure('invalid-finished-time', { index, value: message.finished_at });
        } else if (timestamp != null && finishedTimestamp != null && finishedTimestamp < timestamp) {
            addFailure('finished-before-created', { index });
        }

        if (role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                toolCallCount += 1;
                const callId = call?.id;
                if (!callId) {
                    addFailure('missing-tool-call-id', { index });
                } else if (declaredCalls.has(callId)) {
                    addFailure('duplicate-tool-call-id', { index, toolCallId: callId });
                } else {
                    declaredCalls.set(callId, { index, resolved: false });
                }
            }
        }

        if (role === 'tool') {
            toolResultCount += 1;
            const callId = message.tool_call_id;
            if (!callId) {
                addFailure('missing-tool-result-call-id', { index });
            } else if (!declaredCalls.has(callId)) {
                addFailure('orphan-tool-result', { index, toolCallId: callId });
            } else if (declaredCalls.get(callId).resolved) {
                addFailure('duplicate-tool-result', { index, toolCallId: callId });
            } else {
                declaredCalls.get(callId).resolved = true;
            }
        }
    });

    for (const [toolCallId, call] of declaredCalls) {
        if (!call.resolved) addFailure('missing-tool-result', { index: call.index, toolCallId });
    }

    const parentSessionId = session?.metadata?.parentSessionId
        || session?.metadata?.delegatedFrom
        || null;
    if (parentSessionId && knownSessionIds instanceof Set && !knownSessionIds.has(parentSessionId)) {
        addFailure('missing-parent-session', { parentSessionId });
    }

    return {
        ok: failures.length === 0,
        messageCount: messages.length,
        toolCallCount,
        toolResultCount,
        parentSessionId,
        failures,
    };
}

function legacyEvents(session, options = {}) {
    const validation = options.validation || validateLegacySession(session, options.knownSessionIds);
    const traceId = `legacy:${session.id}`;
    const events = [{
        traceId,
        spanId: traceId,
        eventType: 'task.started',
        actor: 'migration',
        payload: { legacy: true, source: 'postgresql.messages' },
        createdAt: session.startTime,
    }];
    for (const message of session.messages || []) {
        const createdAt = message.created_at || message.timestamp || session.startTime;
        if (message.role === 'user') {
            events.push({ traceId, eventType: 'dialogue.user', actor: 'user', content: message.content, createdAt });
        } else if (message.role === 'assistant') {
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                events.push({
                    traceId,
                    eventType: 'model.tool_calls',
                    actor: 'assistant',
                    payload: {
                        calls: message.tool_calls.map(call => ({
                            id: call.id,
                            name: call.function?.name,
                            arguments: call.function?.arguments,
                        })),
                        legacy: true,
                    },
                    createdAt,
                });
            }
            if (message.content != null) {
                events.push({
                    traceId,
                    eventType: 'dialogue.assistant',
                    actor: 'assistant',
                    content: message.content,
                    createdAt,
                });
            }
        } else if (message.role === 'tool') {
            events.push({
                traceId,
                spanId: message.tool_call_id || null,
                eventType: 'tool.result',
                actor: 'legacy-tool',
                content: message.content,
                payload: { legacy: true },
                createdAt: message.finished_at || createdAt,
            });
        } else {
            // Preserve legacy system/developer/unknown messages in Audit even
            // when they cannot be interpreted as a normal dialogue role.
            events.push({
                traceId,
                eventType: `dialogue.${LEGACY_ROLES.has(message.role) ? message.role : 'unknown'}`,
                actor: message.role || 'unknown',
                content: message.content,
                payload: { legacy: true, originalRole: message.role || null },
                createdAt,
            });
        }
    }
    events.push({
        traceId,
        spanId: traceId,
        eventType: 'task.completed',
        actor: 'migration',
        payload: {
            legacy: true,
            taskBoundaryInferred: false,
            migrationValidation: validation,
        },
        createdAt: session.endTime || new Date().toISOString(),
    });
    return events;
}

async function migrate() {
    const sessions = await Session.list();
    const knownSessionIds = new Set(sessions.map(session => session.id));
    const result = {
        sessions: sessions.length,
        migrated: 0,
        skipped: 0,
        events: 0,
        verified: 0,
        sessionsWithValidationFailures: 0,
        validationFailures: 0,
    };
    for (const info of sessions) {
        const existing = await auditRepository.readEvents({ sessionId: info.id, limit: 1 });
        if (existing.length > 0) {
            const verification = await auditRepository.verifySession(info.id);
            if (!verification.ok) {
                throw new Error(
                    `Audit hash-chain validation failed for ${info.id}: ${verification.failures.join(', ')}`
                );
            }
            result.verified += 1;
            result.skipped += 1;
            continue;
        }
        const session = await Session.load(info.id);
        const validation = validateLegacySession(session, knownSessionIds);
        const events = legacyEvents(session, { validation });
        await auditRepository.appendEvents(info.id, events, {
            checkpoint: {
                migratedFromMessages: true,
                legacyTraceId: `legacy:${info.id}`,
                migrationValidation: validation,
            },
        });
        const verification = await auditRepository.verifySession(info.id);
        if (!verification.ok) {
            throw new Error(
                `Audit hash-chain validation failed after migrating ${info.id}: ${verification.failures.join(', ')}`
            );
        }
        result.verified += 1;
        if (!validation.ok) result.sessionsWithValidationFailures += 1;
        result.validationFailures += validation.failures.length;
        result.migrated += 1;
        result.events += events.length;
    }
    return result;
}

if (require.main === module) {
    migrate()
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error(error.stack || error.message);
            process.exitCode = 1;
        })
        .finally(() => Session.close());
}

module.exports = { migrate, legacyEvents, validateLegacySession };
