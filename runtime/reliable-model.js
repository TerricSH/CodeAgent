const crypto = require('node:crypto');

const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'MODEL_REASONING_MISSING',
    'MODEL_STREAM_UNAVAILABLE',
    'MODEL_REQUEST_TIMEOUT',
]);

function isRetryableModelError(error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status);
    if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
    if (RETRYABLE_CODES.has(error?.code)) return true;
    const text = String(error?.message || error || '').toLowerCase();
    return /connection reset|network|socket|timed? ?out|temporar|rate limit/.test(text);
}

function delay(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

function eventRecord(event, logicalCallId, attemptNo, sequence) {
    return {
        eventId: crypto.randomUUID(),
        logicalCallId,
        attemptNo,
        sequence,
        createdAt: new Date().toISOString(),
        type: event?.type || 'event',
        content: typeof event?.content === 'string' ? event.content : null,
        calls: event?.type === 'tool_calls' ? (event.calls || []) : undefined,
        raw: event?.raw ?? null,
    };
}

function createReliableModelCapability(model, options = {}) {
    if (!model || typeof model.chat !== 'function') {
        throw new Error('Reliable model capability requires chat()');
    }
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
    const retryDelayMs = options.retryDelayMs === undefined
        ? 250
        : Math.max(0, Number(options.retryDelayMs) || 0);
    const requestTimeoutMs = options.requestTimeoutMs === undefined
        ? 120000
        : Math.max(1, Number(options.requestTimeoutMs) || 120000);
    const reasoningRequired = options.reasoningRequired !== false;
    const recorder = options.recorder || null;
    const info = () => typeof model.info === 'function' ? model.info() || {} : {};
    const recorderModelInfo = () => {
        const value = info();
        return {
            ref: value.ref || null,
            model: value.model || null,
            maxContextTokens: Number.isInteger(value.maxContextTokens)
                ? value.maxContextTokens
                : null,
            maxOutputTokens: Number.isInteger(value.maxOutputTokens)
                ? value.maxOutputTokens
                : null,
            reasoningRequired: reasoningRequired || Boolean(value.reasoningRequired),
        };
    };

    async function* chat(messages, chatOptions = {}) {
        const logicalCallId = chatOptions.logicalCallId || crypto.randomUUID();
        let finalError = null;
        let attemptsUsed = 0;
        for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
            attemptsUsed = attemptNo;
            const records = [];
            const timeoutController = new AbortController();
            let requestTimedOut = false;
            const timeout = setTimeout(() => {
                requestTimedOut = true;
                timeoutController.abort();
            }, requestTimeoutMs);
            timeout.unref?.();
            const signals = [timeoutController.signal, chatOptions.signal].filter(Boolean);
            const signal = signals.length === 1
                ? signals[0]
                : (typeof AbortSignal.any === 'function'
                    ? AbortSignal.any(signals)
                    : timeoutController.signal);
            try {
                let sequence = 0;
                try {
                    for await (const event of model.chat(messages, {
                        ...chatOptions,
                        signal,
                        reasoning: {
                            enabled: true,
                            required: reasoningRequired,
                            ...(chatOptions.reasoning || {}),
                        },
                    })) {
                        sequence += 1;
                        records.push(eventRecord(event, logicalCallId, attemptNo, sequence));
                    }
                } catch (error) {
                    if (requestTimedOut) {
                        const timeoutError = new Error(
                            `Model request timed out after ${requestTimeoutMs}ms`
                        );
                        timeoutError.code = 'MODEL_REQUEST_TIMEOUT';
                        timeoutError.status = 408;
                        timeoutError.cause = error;
                        throw timeoutError;
                    }
                    throw error;
                }
                if (reasoningRequired && !records.some(event => (
                    event.type === 'thinking'
                    && typeof event.content === 'string'
                    && event.content.trim().length > 0
                ))) {
                    const error = new Error('Model endpoint did not return required reasoning/thinking events');
                    error.code = 'MODEL_REASONING_MISSING';
                    throw error;
                }
                if (recorder?.recordTransportAttempt) {
                    recorder.recordTransportAttempt({
                        logicalCallId,
                        attemptNo,
                        status: 'succeeded',
                        eventCount: records.length,
                        purpose: chatOptions.purpose || null,
                        model: recorderModelInfo(),
                    });
                }
                if (recorder?.commitModelEvents) {
                    recorder.commitModelEvents({
                        logicalCallId,
                        attemptNo,
                        purpose: chatOptions.purpose || null,
                        model: recorderModelInfo(),
                        messages,
                        tools: chatOptions.tools || [],
                        context: chatOptions.trajectoryContext || null,
                        events: records,
                    });
                }
                for (const record of records) {
                    yield {
                        type: record.type,
                        content: record.content,
                        calls: record.calls,
                        raw: record.raw,
                        eventId: record.eventId,
                        logicalCallId,
                    };
                }
                return;
            } catch (error) {
                clearTimeout(timeout);
                finalError = error;
                const retryable = isRetryableModelError(error);
                if (recorder?.recordTransportAttempt) {
                    recorder.recordTransportAttempt({
                        logicalCallId,
                        attemptNo,
                        status: 'failed',
                        retryable,
                        error: error instanceof Error ? error.message : String(error),
                        errorCode: error?.code || null,
                        purpose: chatOptions.purpose || null,
                        model: recorderModelInfo(),
                        partialEvents: records,
                    });
                }
                if (!retryable || attemptNo >= maxAttempts) break;
                await delay(retryDelayMs * (2 ** (attemptNo - 1)));
            } finally {
                clearTimeout(timeout);
            }
        }
        if (finalError) {
            finalError.infrastructureFailure = true;
            finalError.code = finalError.code || 'MODEL_API_FAILED';
            if (recorder?.recordSemanticEvent) {
                recorder.recordSemanticEvent({
                    eventId: crypto.randomUUID(),
                    logicalCallId,
                    attemptNo: attemptsUsed,
                    type: 'infra_failure',
                    recordType: 'model-infrastructure-failure',
                    purpose: chatOptions.purpose || null,
                    model: recorderModelInfo(),
                    context: chatOptions.trajectoryContext || null,
                    content: null,
                    payload: {
                        error: finalError instanceof Error ? finalError.message : String(finalError),
                        errorCode: finalError.code || null,
                        attempts: attemptsUsed,
                    },
                });
            }
        }
        throw finalError;
    }

    async function completeDetailed(messages, chatOptions = {}) {
        let content = '';
        let reasoning = '';
        const events = [];
        for await (const event of chat(messages, chatOptions)) {
            events.push(event);
            if (event.type === 'content' && typeof event.content === 'string') content += event.content;
            if (event.type === 'thinking' && typeof event.content === 'string') reasoning += event.content;
        }
        return { content, reasoning, events };
    }

    async function complete(messages, chatOptions = {}) {
        return (await completeDetailed(messages, chatOptions)).content;
    }

    return Object.freeze({ chat, complete, completeDetailed, info });
}

module.exports = {
    createReliableModelCapability,
    isRetryableModelError,
    eventRecord,
};
