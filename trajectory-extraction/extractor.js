const { extractMessageSpans } = require('./message-spans');
const { compareTrajectories } = require('./comparison');
const { sanitizeValue, truncateText } = require('./sanitize');

const SCHEMA_VERSION = 1;

function normalizeRolloutId(record, index) {
    const value = record.rolloutId || record.id || `trajectory-${String(index + 1).padStart(3, '0')}`;
    return truncateText(value, 200);
}

function evaluationOutcome(record) {
    const evaluation = record.evaluation && typeof record.evaluation === 'object'
        ? record.evaluation
        : null;
    return evaluation ? {
        ok: typeof evaluation.ok === 'boolean' ? evaluation.ok : null,
        exitCode: Number.isInteger(evaluation.exitCode) ? evaluation.exitCode : null,
        signal: evaluation.signal || null,
        timedOut: Boolean(evaluation.timedOut),
        durationMs: Number.isFinite(evaluation.durationMs) ? evaluation.durationMs : null,
        errorCode: evaluation.errorCode || null,
        error: evaluation.error ? truncateText(evaluation.error, 1000) : null,
        stdout: truncateText(evaluation.stdout, 2000),
        stderr: truncateText(evaluation.stderr, 2000),
    } : null;
}

function changedFiles(record) {
    const files = Array.isArray(record.diff?.files) ? record.diff.files : [];
    return files.slice(0, 500).map(file => ({
        path: truncateText(file.path, 1000),
        status: file.status || null,
        additions: Number.isFinite(file.additions) ? file.additions : null,
        deletions: Number.isFinite(file.deletions) ? file.deletions : null,
    }));
}

function determineOutcomeStatus({ evaluation, reward, agentError, violations }) {
    if (agentError || violations.length > 0 || evaluation?.ok === false) return 'failed';
    if (evaluation?.ok === true) return 'succeeded';
    if (Number.isFinite(reward)) {
        if (reward > 0) return 'succeeded';
        if (reward < 0) return 'failed';
    }
    return 'unknown';
}

function repeatedToolCalls(toolSpans) {
    const groups = new Map();
    for (const span of toolSpans) {
        if (!groups.has(span.fingerprint)) {
            groups.set(span.fingerprint, {
                fingerprint: span.fingerprint,
                toolName: span.name,
                count: 0,
                evidenceSpanIds: [],
            });
        }
        const group = groups.get(span.fingerprint);
        group.count += 1;
        group.evidenceSpanIds.push(span.spanId);
    }
    return [...groups.values()].filter(item => item.count > 1);
}

function failureReasons({ agentError, violations, evaluation, toolSpans }) {
    const reasons = [];
    if (agentError) {
        reasons.push({
            code: 'AGENT_ERROR',
            message: truncateText(agentError, 1000),
            evidenceSpanIds: [],
        });
    }
    if (violations.length > 0) {
        reasons.push({
            code: 'PROTECTED_PATH_CHANGED',
            message: `Protected paths changed: ${violations.join(', ')}`,
            evidenceSpanIds: toolSpans
                .filter(span => span.phase === 'mutation')
                .map(span => span.spanId),
        });
    }
    if (evaluation?.ok === false) {
        reasons.push({
            code: evaluation.errorCode || (evaluation.timedOut ? 'EVALUATION_TIMEOUT' : 'EVALUATION_FAILED'),
            message: truncateText(
                evaluation.error || evaluation.stderr || `Evaluator exited with ${evaluation.exitCode}`,
                1000
            ),
            evidenceSpanIds: toolSpans
                .filter(span => span.phase === 'mutation' || span.phase === 'verification')
                .map(span => span.spanId),
        });
    }
    for (const span of toolSpans.filter(item => item.status.code === 'error')) {
        reasons.push({
            code: 'TOOL_ERROR',
            message: `${span.name}: ${span.status.reason || 'tool call failed'}`,
            evidenceSpanIds: [span.spanId],
        });
    }
    return reasons;
}

function buildVerifierLinks(evaluation, toolSpans) {
    if (!evaluation) return [];
    const relevant = toolSpans
        .filter(span => span.phase === 'mutation' || span.phase === 'verification')
        .map(span => span.spanId);
    return [{
        verifier: 'outcome.evaluation',
        relation: 'precedes',
        candidateSpanIds: relevant,
        passed: evaluation.ok,
        note: 'candidateSpanIds are temporal/heuristic links, not proof of causality.',
    }];
}

class TrajectoryExtractor {
    constructor(options = {}) {
        this.options = { maxMessages: 1000, ...options };
    }

    extract(record, index = 0) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new TypeError('Trajectory record must be an object');
        }
        if (!Array.isArray(record.messages)) {
            throw new TypeError('Trajectory record.messages must be an array');
        }
        const rolloutId = normalizeRolloutId(record, index);
        const traceId = truncateText(record.traceId || record.runId || rolloutId, 200);
        const spans = extractMessageSpans(record.messages, rolloutId, this.options);
        const toolSpans = spans.filter(span => span.spanKind === 'tool');
        const evaluation = evaluationOutcome(record);
        const reward = Number.isFinite(record.reward)
            ? record.reward
            : Number.isFinite(record.score) ? record.score : null;
        const agentError = record.agentError ? truncateText(record.agentError, 1000) : null;
        const violations = Array.isArray(record.protectedPathViolations)
            ? record.protectedPathViolations.map(item => truncateText(item, 1000))
            : [];
        const files = changedFiles(record);
        const status = determineOutcomeStatus({ evaluation, reward, agentError, violations });
        const finalReply = truncateText(record.finalReply ?? record.reply ?? '', 4000);
        const startedAt = typeof record.startedAt === 'string' ? record.startedAt : null;
        const finishedAt = typeof record.finishedAt === 'string' ? record.finishedAt : null;

        return {
            schemaVersion: SCHEMA_VERSION,
            traceId,
            rolloutId,
            spanId: rolloutId,
            spanKind: 'agent',
            name: truncateText(record.name || 'agent.rollout', 200),
            startedAt,
            finishedAt,
            source: {
                messageCount: record.messages.length,
                suiteId: record.suiteId ? truncateText(record.suiteId, 200) : null,
                recordType: record.recordType ? truncateText(record.recordType, 200) : null,
            },
            context: {
                task: record.task ? truncateText(record.task, 8000) : null,
                skill: record.skill ? truncateText(record.skill, 16000) : null,
                systemPrompt: record.systemPrompt ? truncateText(record.systemPrompt, 16000) : null,
                models: sanitizeValue(record.models || null),
            },
            spans,
            outcome: {
                status,
                reward,
                agentError,
                evaluation,
                protectedPathViolations: violations,
                diff: {
                    fileCount: Number.isFinite(record.diff?.fileCount) ? record.diff.fileCount : files.length,
                    changedBytes: Number.isFinite(record.diff?.changedBytes) ? record.diff.changedBytes : null,
                    files,
                },
                finalReply,
            },
            summary: {
                totalSpans: spans.length,
                inputSpans: spans.filter(span => span.spanKind === 'input').length,
                assistantSpans: spans.filter(span => span.spanKind === 'llm').length,
                toolCalls: toolSpans.length,
                successfulToolCalls: toolSpans.filter(span => span.status.code === 'ok').length,
                failedToolCalls: toolSpans.filter(span => span.status.code === 'error').length,
                unknownToolCalls: toolSpans.filter(span => span.status.code === 'unknown').length,
            },
            signals: {
                successfulSpanIds: toolSpans
                    .filter(span => span.status.code === 'ok')
                    .map(span => span.spanId),
                failedSpanIds: toolSpans
                    .filter(span => span.status.code === 'error')
                    .map(span => span.spanId),
                repeatedToolCalls: repeatedToolCalls(toolSpans),
                failureReasons: failureReasons({ agentError, violations, evaluation, toolSpans }),
                verifierLinks: buildVerifierLinks(evaluation, toolSpans),
            },
            metadata: sanitizeValue(record.metadata || {}),
        };
    }

    extractMany(records, options = {}) {
        if (!Array.isArray(records) || records.length === 0) {
            throw new TypeError('Trajectory records must be a non-empty array');
        }
        const maxRecords = Math.min(Math.max(1, Number(options.maxRecords) || 32), 256);
        if (records.length > maxRecords) {
            throw new Error(`Received ${records.length} trajectory records; limit is ${maxRecords}`);
        }
        const trajectories = records.map((record, index) => this.extract(record, index));
        return {
            schemaVersion: SCHEMA_VERSION,
            trajectories,
            comparison: options.compare === false ? null : compareTrajectories(trajectories),
        };
    }
}

module.exports = { SCHEMA_VERSION, TrajectoryExtractor };
