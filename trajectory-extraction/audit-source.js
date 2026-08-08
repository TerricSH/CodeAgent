const auditRepository = require('../data-layer/repositories/audit-repository');
const HistoryRagService = require('../rag-core/history-service');
const { sanitizeValue, truncateText } = require('./sanitize');

function spanKind(eventType) {
    if (eventType.startsWith('model.')) return 'llm';
    if (eventType.startsWith('tool.')) return 'tool';
    if (eventType.startsWith('subagent.')) return 'subagent';
    if (eventType.startsWith('rag.')) return 'rag';
    if (eventType.startsWith('skill.')) return 'skill';
    if (eventType.startsWith('context.')) return 'context';
    if (eventType.startsWith('task.')) return 'agent';
    return 'event';
}

function filteredEvents(events, options) {
    return events.filter(event => {
        if (options.includeReasoning === false && event.eventType === 'model.reasoning') return false;
        if (options.includeContextEvents === false && event.eventType.startsWith('context.')) return false;
        return true;
    });
}

function buildSpanTree(events, traceId) {
    const spans = new Map();
    const root = {
        spanId: traceId,
        parentSpanId: null,
        spanKind: 'agent',
        name: 'task',
        events: [],
        children: [],
    };
    spans.set(traceId, root);
    for (const event of events) {
        const id = event.spanId || `event:${event.id}`;
        if (!spans.has(id)) {
            spans.set(id, {
                spanId: id,
                parentSpanId: event.parentSpanId || traceId,
                spanKind: spanKind(event.eventType),
                name: event.eventType.split('.')[0],
                events: [],
                children: [],
            });
        }
        spans.get(id).events.push({
            id: event.id,
            sequence: event.sequence,
            eventType: event.eventType,
            actor: event.actor,
            content: truncateText(event.content, 100000),
            payload: sanitizeValue(event.payload),
            tokenCount: event.tokenCount,
            createdAt: event.createdAt,
        });
    }
    for (const span of spans.values()) {
        if (span === root) continue;
        const parent = spans.get(span.parentSpanId) || root;
        parent.children.push(span);
    }
    const sort = span => {
        span.events.sort((left, right) => left.sequence - right.sequence);
        span.children.sort((left, right) => {
            const leftSequence = left.events[0]?.sequence || Number.MAX_SAFE_INTEGER;
            const rightSequence = right.events[0]?.sequence || Number.MAX_SAFE_INTEGER;
            return leftSequence - rightSequence;
        });
        span.children.forEach(sort);
    };
    sort(root);
    return root;
}

function outcome(events) {
    const completed = events.find(event => event.eventType === 'task.completed');
    const failed = events.find(event => event.eventType === 'task.failed');
    return {
        status: failed ? 'failed' : (completed ? 'succeeded' : 'unknown'),
        reward: null,
        error: failed?.payload?.error || null,
        verification: events
            .filter(event => /verif|evaluation|outcome/.test(event.eventType))
            .map(event => sanitizeValue(event.payload)),
    };
}

class AuditTrajectorySource {
    constructor(options = {}) {
        this.auditRepository = options.auditRepository || auditRepository;
        this.historyRag = options.historyRag || new HistoryRagService(options.historyOptions);
    }

    async trace(traceId, options = {}, seen = new Set()) {
        if (!traceId || seen.has(traceId)) return null;
        seen.add(traceId);
        const reader = this.auditRepository.readAllEvents || this.auditRepository.readEvents;
        const all = await reader.call(this.auditRepository, { traceId, limit: 100000 });
        if (all.length === 0) return null;
        const events = filteredEvents(all, options);
        const childLinks = all.filter(event => event.eventType === 'subagent.started');
        const children = [];
        if (options.includeSubagents !== false) {
            for (const link of childLinks) {
                const childTraceId = link.payload?.childTraceId || link.spanId;
                const child = await this.trace(childTraceId, options, seen);
                if (child) children.push(child);
            }
        }
        const sessionId = all[0].sessionId;
        return {
            schemaVersion: 2,
            sourceType: 'audit',
            traceId,
            sessionId,
            spanTree: buildSpanTree(events, traceId),
            events,
            subagents: children,
            outcome: outcome(all),
            summary: {
                totalEvents: events.length,
                totalSpans: new Set(events.map(event => event.spanId).filter(Boolean)).size,
                toolCalls: all.filter(event => event.eventType === 'tool.started').length,
                failedToolCalls: all.filter(event => event.eventType === 'tool.failed').length,
                ragQueries: all.filter(event => event.eventType === 'rag.query').length,
                skillsLoaded: all.filter(event => event.eventType === 'skill.loaded').length,
                contextEvictions: all.filter(event => event.eventType === 'context.evicted').length,
            },
        };
    }

    async session(sessionId, options = {}) {
        const reader = this.auditRepository.readAllEvents || this.auditRepository.readEvents;
        const events = await reader.call(this.auditRepository, { sessionId, limit: 100000 });
        const traceIds = [...new Set(events
            .filter(event => event.eventType === 'task.started' && event.traceId)
            .map(event => event.traceId))];
        return (await Promise.all(traceIds.map(traceId => this.trace(traceId, options))))
            .filter(Boolean);
    }

    async query(query, options = {}) {
        const sessions = options.sessionId
            ? [{ sessionId: options.sessionId }]
            : await this.auditRepository.listAuditSessions(options.sessionLimit || 1000);
        const result = await this.historyRag.search({
            query,
            sessionIds: sessions.map(item => item.sessionId),
            limit: options.limit || 20,
            indexAll: !options.sessionId,
        });
        const traceIds = [...new Set(result.hits.map(hit => hit.metadata?.traceId).filter(Boolean))];
        return (await Promise.all(traceIds.map(traceId => this.trace(traceId, options))))
            .filter(Boolean);
    }
}

module.exports = { AuditTrajectorySource, buildSpanTree, filteredEvents, outcome };
