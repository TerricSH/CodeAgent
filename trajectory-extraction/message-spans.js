const crypto = require('node:crypto');
const { parseAndSanitize, sanitizeValue, truncateText } = require('./sanitize');

const VERIFY_COMMAND = /(?:^|\s)(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|pytest|jest|vitest|mocha|cargo\s+test|go\s+test|dotnet\s+test|gradle\s+test|mvn\s+test|lint|typecheck|build|verify|check)(?:\s|$)/i;
const MUTATION_COMMAND = /(?:^|\s)(?:apply_patch|sed|perl|tee|touch|mkdir|cp|copy|mv|move|npm\s+install|pnpm\s+install|yarn\s+add)(?:\s|$)|(?:^|[^>])>{1,2}(?:[^>]|$)/i;

function sourceTime(message, key) {
    const value = message && message[key];
    return typeof value === 'string' && value ? value : null;
}

function statusFromToolResult(value) {
    if (value == null) return { code: 'unknown', reason: 'tool result missing' };
    if (typeof value === 'object' && !Array.isArray(value)) {
        if (value.ok === false) return { code: 'error', reason: truncateText(value.error || 'ok=false', 500) };
        if (value.error) return { code: 'error', reason: truncateText(value.error, 500) };
        if (Number(value.summary?.failed) > 0) {
            return { code: 'error', reason: `${value.summary.failed} operation(s) failed` };
        }
        if (value.ok === true || Number(value.summary?.failed) === 0) return { code: 'ok' };
        if (Number.isInteger(value.exitCode)) {
            return value.exitCode === 0
                ? { code: 'ok' }
                : { code: 'error', reason: `exit code ${value.exitCode}` };
        }
    }
    return { code: 'unknown' };
}

function classifyToolPhase(name, input) {
    const normalizedName = String(name || '').toLowerCase();
    if (/(?:test|verify|check|lint|build)/.test(normalizedName)) return 'verification';
    if (/(?:write|edit|patch|delete|move|create)/.test(normalizedName)) return 'mutation';
    const command = input && typeof input.command === 'string' ? input.command : '';
    if (VERIFY_COMMAND.test(command)) return 'verification';
    if (MUTATION_COMMAND.test(command)) return 'mutation';
    if (/(?:read|list|search|query|status|inspect)/.test(normalizedName)) return 'observation';
    return 'action';
}

function fingerprint(name, input) {
    const material = `${name}\n${JSON.stringify(input)}`;
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function createSpanFactory(rolloutId) {
    let sequence = 0;
    return function span(fields) {
        sequence += 1;
        return {
            spanId: `${rolloutId}:span-${String(sequence).padStart(4, '0')}`,
            parentSpanId: rolloutId,
            sequence,
            ...fields,
        };
    };
}

function extractMessageSpans(messages, rolloutId, options = {}) {
    if (!Array.isArray(messages)) throw new TypeError('Trajectory messages must be an array');
    const maxMessages = Math.min(Math.max(1, Number(options.maxMessages) || 1000), 5000);
    if (messages.length > maxMessages) {
        throw new Error(`Trajectory contains ${messages.length} messages; limit is ${maxMessages}`);
    }

    const createSpan = createSpanFactory(rolloutId);
    const resultByCallId = new Map();
    const pairedResultIndexes = new Set();
    messages.forEach((message, index) => {
        if (message?.role === 'tool' && typeof message.tool_call_id === 'string') {
            if (!resultByCallId.has(message.tool_call_id)) resultByCallId.set(message.tool_call_id, []);
            resultByCallId.get(message.tool_call_id).push({ message, index });
        }
    });

    const spans = [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex] || {};
        const role = typeof message.role === 'string' ? message.role : 'unknown';
        const startedAt = sourceTime(message, 'created_at') || sourceTime(message, 'timestamp');
        const finishedAt = sourceTime(message, 'finished_at');

        if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            if (message.content != null && String(message.content).trim()) {
                spans.push(createSpan({
                    spanKind: 'llm',
                    name: 'assistant.response',
                    status: { code: 'ok' },
                    startedAt,
                    finishedAt,
                    source: { messageIndexes: [messageIndex] },
                    output: { content: sanitizeValue(message.content) },
                }));
            }
            for (const call of message.tool_calls) {
                const callId = typeof call?.id === 'string' && call.id
                    ? call.id
                    : `message-${messageIndex}-call-${spans.length + 1}`;
                const name = call?.function?.name || call?.name || 'unknown_tool';
                const rawArguments = call?.function?.arguments ?? call?.arguments ?? {};
                const input = parseAndSanitize(rawArguments);
                const candidates = resultByCallId.get(callId) || [];
                const matched = candidates.find(item => !pairedResultIndexes.has(item.index)) || null;
                if (matched) pairedResultIndexes.add(matched.index);
                const output = matched ? parseAndSanitize(matched.message.content) : null;
                const status = statusFromToolResult(output);
                spans.push(createSpan({
                    spanKind: 'tool',
                    name: String(name),
                    toolCallId: callId,
                    phase: classifyToolPhase(name, input),
                    fingerprint: fingerprint(name, input),
                    status,
                    startedAt,
                    finishedAt: matched
                        ? sourceTime(matched.message, 'finished_at')
                            || sourceTime(matched.message, 'created_at')
                            || sourceTime(matched.message, 'timestamp')
                        : finishedAt,
                    source: {
                        messageIndexes: matched ? [messageIndex, matched.index] : [messageIndex],
                    },
                    input,
                    output,
                }));
            }
            continue;
        }

        if (role === 'tool') {
            if (pairedResultIndexes.has(messageIndex)) continue;
            const output = parseAndSanitize(message.content);
            spans.push(createSpan({
                spanKind: 'tool',
                name: 'orphan_tool_result',
                toolCallId: message.tool_call_id || null,
                phase: 'action',
                fingerprint: fingerprint('orphan_tool_result', { toolCallId: message.tool_call_id }),
                status: statusFromToolResult(output),
                startedAt,
                finishedAt,
                source: { messageIndexes: [messageIndex] },
                input: null,
                output,
            }));
            continue;
        }

        if (role === 'assistant') {
            spans.push(createSpan({
                spanKind: 'llm',
                name: 'assistant.response',
                status: { code: 'ok' },
                startedAt,
                finishedAt,
                source: { messageIndexes: [messageIndex] },
                output: { content: sanitizeValue(message.content) },
            }));
            continue;
        }

        spans.push(createSpan({
            spanKind: 'input',
            name: `${role}.message`,
            status: { code: 'ok' },
            startedAt,
            finishedAt,
            source: { messageIndexes: [messageIndex] },
            input: { content: sanitizeValue(message.content) },
        }));
    }
    return spans;
}

module.exports = {
    VERIFY_COMMAND,
    MUTATION_COMMAND,
    statusFromToolResult,
    classifyToolPhase,
    extractMessageSpans,
};
