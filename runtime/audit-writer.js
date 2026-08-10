const auditRepository = require('../data-layer/repositories/audit-repository');

class AuditWriter {
    constructor(sessionId, options = {}) {
        if (!sessionId) throw new Error('AuditWriter requires sessionId');
        this.sessionId = sessionId;
        this.repository = options.repository || auditRepository;
        this.batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
            ? options.batchSize
            : 32;
        this.buffer = [];
        this.queue = Promise.resolve();
        this.pendingFlushes = 0;
        this.activeTraceId = null;
        this.activeTraceStartedAt = null;
        this.activeTraceStats = null;
        this.previousTraceId = options.previousTraceId || null;
        this.checkpointProvider = typeof options.checkpointProvider === 'function'
            ? options.checkpointProvider
            : null;
        this.sessionStateProvider = typeof options.sessionStateProvider === 'function'
            ? options.sessionStateProvider
            : null;
    }

    record(event = {}, options = {}) {
        const normalized = this._normalizeEvent(event);
        this.buffer.push(normalized);
        this._trackEvent(normalized);
        if (this.buffer.length >= this.batchSize && options.deferFlush !== true) {
            // The scheduled promise is deliberately observed here. A later explicit
            // flush still sees a restored batch if the repository operation fails.
            this._scheduleFlush().catch(() => {});
        }
        return normalized;
    }

    _trackEvent(normalized) {
        if (this.activeTraceStats && normalized.traceId === this.activeTraceId) {
            this.activeTraceStats.eventCount += 1;
            if (Number.isInteger(normalized.tokenCount)) {
                this.activeTraceStats.recordedTokenCount += normalized.tokenCount;
            }
        }
    }

    _normalizeEvent(event = {}) {
        return {
            ...event,
            traceId: event.traceId || this.activeTraceId || null,
            createdAt: event.createdAt || new Date().toISOString(),
        };
    }

    startTrace(payload = {}) {
        const traceId = payload.traceId || globalThis.crypto.randomUUID();
        const startedAt = new Date().toISOString();
        this.activeTraceId = traceId;
        this.activeTraceStartedAt = startedAt;
        this.activeTraceStats = { eventCount: 0, recordedTokenCount: 0 };
        this.record({
            traceId,
            spanId: traceId,
            eventType: 'task.started',
            actor: 'user',
            content: payload.content || null,
            payload: { ...payload, previousTraceId: this.previousTraceId },
            createdAt: startedAt,
        });
        return traceId;
    }

    finishTrace(status = 'completed', payload = {}) {
        if (!this.activeTraceId) return;
        const traceId = this.activeTraceId;
        const finishedAt = new Date().toISOString();
        const startedAt = this.activeTraceStartedAt;
        const stats = this.activeTraceStats || { eventCount: 0, recordedTokenCount: 0 };
        this.record({
            traceId,
            spanId: traceId,
            eventType: `task.${status}`,
            actor: 'runtime',
            payload: {
                ...payload,
                durationMs: startedAt
                    ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
                    : null,
                eventCountBeforeCompletion: stats.eventCount,
                recordedTokenCount: stats.recordedTokenCount,
            },
            createdAt: finishedAt,
        });
        this.previousTraceId = traceId;
        this.activeTraceId = null;
        this.activeTraceStartedAt = null;
        this.activeTraceStats = null;
    }

    get dirty() {
        return this.buffer.length > 0 || this.pendingFlushes > 0;
    }

    setCheckpointProvider(provider) {
        this.checkpointProvider = typeof provider === 'function' ? provider : null;
    }

    setSessionStateProvider(provider) {
        this.sessionStateProvider = typeof provider === 'function' ? provider : null;
    }

    _scheduleFlush(checkpoint, client) {
        if (this.buffer.length === 0 && checkpoint === undefined && !this.checkpointProvider) {
            return this.queue;
        }
        this.pendingFlushes += 1;
        const task = async () => {
            const batch = this.buffer.splice(0, this.buffer.length);
            const effectiveCheckpoint = checkpoint === undefined && this.checkpointProvider
                ? this.checkpointProvider()
                : checkpoint;
            const sessionState = this.sessionStateProvider ? this.sessionStateProvider() : undefined;
            try {
                return await this.repository.appendEvents(this.sessionId, batch, {
                    checkpoint: effectiveCheckpoint,
                    client,
                    sessionState,
                });
            } catch (error) {
                // A failed PostgreSQL transaction must not silently discard Audit
                // events. Put the batch back in front of later events for retry.
                this.buffer = [...batch, ...this.buffer];
                throw error;
            } finally {
                this.pendingFlushes -= 1;
            }
        };
        this.queue = this.queue.then(task, task);
        return this.queue;
    }

    flush(checkpoint, client) {
        return this._scheduleFlush(checkpoint, client);
    }

    appendTransactional(event, checkpoint, client) {
        if (!client) throw new Error('appendTransactional requires a PostgreSQL transaction client');
        const transactionalEvent = this._normalizeEvent(event);
        this.pendingFlushes += 1;
        const task = async () => {
            const prior = this.buffer.splice(0, this.buffer.length);
            const sessionState = this.sessionStateProvider ? this.sessionStateProvider() : undefined;
            try {
                const result = await this.repository.appendEvents(
                    this.sessionId,
                    [...prior, transactionalEvent],
                    { checkpoint, client, sessionState }
                );
                // The domain event only exists if its surrounding PostgreSQL
                // transaction commits, so do not count it before this succeeds.
                this._trackEvent(transactionalEvent);
                return result;
            } catch (error) {
                // Restore events that existed before the transaction, but deliberately
                // drop its event: the corresponding domain mutation was rolled back.
                this.buffer = [...prior, ...this.buffer];
                throw error;
            } finally {
                this.pendingFlushes -= 1;
            }
        };
        this.queue = this.queue.then(task, task);
        return this.queue;
    }
}

module.exports = AuditWriter;
