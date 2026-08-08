const { normalizeMessage } = require('./messages');
const { estimateTokens } = require('./tokens');
const path = require('node:path');
const { loadPromptTemplate } = require('../prompts/loader');

const renderCacheSummary = loadPromptTemplate(path.join(__dirname, 'prompts', 'cache-summary.md'));
const renderSourceReference = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'source-reference.md')
);

function cloneMessages(messages) {
    return messages.map(message => normalizeMessage(message));
}

function inferKind(messages) {
    if (messages.some(message => message.role === 'tool')) return 'tool_exchange';
    if (messages.some(message => message.role === 'user')) return 'dialogue';
    return 'dialogue';
}

class ContextCache {
    constructor(options = {}) {
        this.sessionId = options.sessionId || null;
        this.turn = Number.isInteger(options.turn) ? options.turn : 0;
        this.entries = [];
        this._sequence = 0;
        this._audit = null;
        this._loader = typeof options.loader === 'function' ? options.loader : null;
        this._openDialogueId = null;
        this._openToolSpanId = null;

        if (Array.isArray(options.messages) && options.messages.length > 0) {
            this._bootstrap(options.messages);
        }
        if (Array.isArray(options.entries)) {
            for (const entry of options.entries) {
                this.add(entry.messages || [], entry);
            }
        }
        this._openDialogueId = options.openDialogueId || this._openDialogueId;
        this._openToolSpanId = options.openToolSpanId || this._openToolSpanId;
        this._audit = typeof options.audit === 'function' ? options.audit : null;
    }

    setAuditSink(sink) {
        this._audit = typeof sink === 'function' ? sink : null;
    }

    setLoader(loader) {
        this._loader = typeof loader === 'function' ? loader : null;
    }

    _emit(eventType, entry, payload = {}, content = null, eventOptions = {}) {
        if (!this._audit) return;
        this._audit({
            eventType,
            actor: eventOptions.actor || 'context',
            spanId: entry?.spanId || null,
            content,
            payload: {
                cacheNodeId: entry?.id || null,
                kind: entry?.kind || null,
                sourceRef: entry?.sourceRef || null,
                ...payload,
            },
            tokenCount: entry?.tokenCount ?? null,
            forceBlob: eventOptions.forceBlob === undefined
                ? content != null
                : eventOptions.forceBlob,
            indexable: eventOptions.indexable === true,
        });
    }

    _bootstrap(messages) {
        let pendingTool = null;
        for (const raw of messages) {
            const message = normalizeMessage(raw);
            if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
                pendingTool = this.add([message], { kind: 'tool_exchange', required: true });
                this._openToolSpanId = pendingTool.id;
                continue;
            }
            if (message.role === 'tool' && pendingTool) {
                this.append(pendingTool.id, message);
                const expected = new Set(pendingTool.messages[0].tool_calls.map(call => call.id));
                const found = new Set(pendingTool.messages.slice(1).map(item => item.tool_call_id));
                if ([...expected].every(id => found.has(id))) {
                    pendingTool.required = false;
                    pendingTool = null;
                    this._openToolSpanId = null;
                }
                continue;
            }
            pendingTool = null;
            this._openToolSpanId = null;
            if (message.role === 'user') {
                const entry = this.add([message], { kind: 'dialogue' });
                this._openDialogueId = entry.id;
            } else if (message.role === 'assistant' && this._openDialogueId) {
                this.append(this._openDialogueId, message);
                this._openDialogueId = null;
            } else {
                this.add([message], { kind: inferKind([message]) });
            }
        }
    }

    beginTurn(taskRef = null) {
        this.turn += 1;
        this._openDialogueId = null;
        for (const entry of this.entries) {
            if (entry.resident && !entry.required && this.turn - entry.lastUsedTurn >= 3) {
                this.evict(entry.id, 'unused-for-three-turns');
            }
        }
        return { turn: this.turn, taskRef };
    }

    completeTask(taskRef, reason = 'task-completed') {
        if (!taskRef) return [];
        const transientKinds = new Set([
            'skill', 'tool_exchange', 'subagent_result', 'workspace_data',
            'history_result', 'web_result', 'error_attempt', 'decision',
        ]);
        const evicted = [];
        for (const entry of this.entries) {
            if (entry.taskRef !== taskRef || !transientKinds.has(entry.kind)) continue;
            entry.required = false;
            if (this.evict(entry.id, reason)) evicted.push(entry.id);
        }
        return evicted;
    }

    add(messages, options = {}) {
        const normalized = cloneMessages(Array.isArray(messages) ? messages : [messages]);
        const id = options.id || globalThis.crypto.randomUUID();
        const entry = {
            id,
            kind: options.kind || inferKind(normalized),
            sourceRef: options.sourceRef || `context:${this.sessionId || 'transient'}:${id}`,
            taskRef: options.taskRef || null,
            spanId: options.spanId || id,
            atomicGroupId: options.atomicGroupId || id,
            useCount: Number.isInteger(options.useCount) ? options.useCount : 1,
            createdTurn: Number.isInteger(options.createdTurn) ? options.createdTurn : this.turn,
            lastUsedTurn: Number.isInteger(options.lastUsedTurn) ? options.lastUsedTurn : this.turn,
            tokenCount: normalized.length > 0
                ? normalized.reduce((sum, message) => sum + estimateTokens(message), 0)
                : (Number.isInteger(options.tokenCount) ? options.tokenCount : 0),
            representation: options.representation || 'full',
            resident: options.resident !== false,
            required: options.required === true,
            sequence: Number.isInteger(options.sequence) ? options.sequence : ++this._sequence,
            messages: normalized,
            summary: options.summary || null,
            metadata: options.metadata && typeof options.metadata === 'object'
                ? { ...options.metadata }
                : {},
        };
        this._sequence = Math.max(this._sequence, entry.sequence);
        this.entries.push(entry);
        this._emit(
            'context.loaded',
            entry,
            { representation: entry.representation },
            JSON.stringify(entry.messages)
        );
        return entry;
    }

    append(id, message) {
        const entry = this.entries.find(candidate => candidate.id === id);
        if (!entry) throw new Error(`Unknown context cache node: ${id}`);
        const normalized = normalizeMessage(message);
        entry.messages.push(normalized);
        entry.tokenCount += estimateTokens(normalized);
        entry.lastUsedTurn = this.turn;
        this._emit(
            'context.updated',
            entry,
            { representation: entry.representation },
            JSON.stringify(entry.messages)
        );
        return entry;
    }

    addUser(content, options = {}) {
        const entry = this.add({ role: 'user', content }, {
            ...options,
            kind: options.kind || 'dialogue',
            required: true,
        });
        this._openDialogueId = entry.id;
        return entry;
    }

    addAssistant(content, options = {}) {
        let entry = this._openDialogueId
            ? this.entries.find(candidate => candidate.id === this._openDialogueId)
            : null;
        const latestEntry = this.entries[this.entries.length - 1] || null;
        if (entry && latestEntry === entry) {
            this.append(entry.id, { role: 'assistant', content });
            entry.required = false;
        } else {
            // A Tool/RAG/Subagent span may have occurred after the user message. In that
            // case the final assistant message must remain a later cache node so causal
            // ordering is not changed merely to make the dialogue node atomic.
            if (entry) entry.required = false;
            entry = this.add({ role: 'assistant', content }, {
                ...options,
                atomicGroupId: entry?.atomicGroupId,
                metadata: {
                    ...(options.metadata || {}),
                    dialogueContinuation: Boolean(entry),
                },
            });
        }
        this._openDialogueId = null;
        return entry;
    }

    addAssistantToolCalls(toolCalls, options = {}) {
        const message = {
            role: 'assistant',
            content: options.content || null,
            tool_calls: toolCalls.map(call => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
        };
        const entry = this.add(message, {
            ...options,
            kind: options.kind || 'tool_exchange',
            required: true,
            metadata: {
                ...(options.metadata || {}),
                pendingToolCallIds: toolCalls.map(call => call.id),
                closed: false,
            },
        });
        this._openToolSpanId = entry.id;
        return entry;
    }

    addToolResult(toolCallId, result, options = {}) {
        let entry = this._openToolSpanId
            ? this.entries.find(candidate => candidate.id === this._openToolSpanId)
            : null;
        if (!entry) {
            entry = this.add([], {
                ...options,
                kind: options.kind || 'tool_exchange',
                required: true,
            });
            this._openToolSpanId = entry.id;
        }
        this.append(entry.id, {
            role: 'tool',
            tool_call_id: toolCallId,
            content: typeof result === 'string' ? result : JSON.stringify(result),
            finished_at: options.finishedAt || null,
        });
        if (options.failed) {
            entry.metadata.hasFailure = true;
            if (entry.kind === 'tool_exchange') entry.kind = 'error_attempt';
        }
        const pending = new Set(entry.metadata.pendingToolCallIds || []);
        const completed = new Set(entry.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
        if (pending.size === 0 || [...pending].every(id => completed.has(id))) {
            // A completed Tool span must be sent to the model once before it becomes
            // evictable. This also gives Subagent results the required first delivery.
            entry.metadata.closed = true;
            entry.metadata.mustSend = true;
            entry.required = true;
            this._openToolSpanId = null;
        }
        return entry;
    }

    load(value, options = {}) {
        if (typeof value === 'string') {
            return this.add({ role: options.role || 'system', content: value }, options);
        }
        const source = value && typeof value === 'object' ? value : {};
        const messages = source.messages || {
            role: source.role || options.role || 'system',
            content: source.content || '',
        };
        return this.add(messages, { ...source, ...options });
    }

    async restore(id, reason = 'relevant-again') {
        const entry = this.entries.find(candidate => candidate.id === id);
        if (!entry) return null;
        if ((!entry.messages || entry.messages.length === 0) && this._loader) {
            const loaded = await this._loader(entry.sourceRef, entry);
            if (loaded) {
                entry.messages = cloneMessages(Array.isArray(loaded) ? loaded : [loaded]);
                entry.tokenCount = entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
            }
        }
        if (!entry.messages || entry.messages.length === 0) return null;
        entry.resident = true;
        entry.representation = entry.summary ? 'summary+source' : 'full';
        this.touch(id, reason);
        this._emit('context.restored', entry, { reason });
        return entry;
    }

    touch(id, reason = 'used') {
        const entry = this.entries.find(candidate => candidate.id === id);
        if (!entry) return null;
        entry.useCount += 1;
        entry.lastUsedTurn = this.turn;
        this._emit('context.touched', entry, { reason, useCount: entry.useCount });
        if (entry.kind === 'skill' && reason === 'sent-to-model') {
            const name = entry.metadata?.skillName || entry.sourceRef;
            this._emit(
                'skill.used',
                entry,
                { name, useCount: entry.useCount },
                name,
                { actor: 'skill', forceBlob: false, indexable: true }
            );
        }
        return entry;
    }

    compress(id, summary, reason = 'token-pressure') {
        const entry = this.entries.find(candidate => candidate.id === id);
        if (!entry || !summary) return null;
        entry.summary = String(summary);
        entry.messages = [{
            role: 'system',
            content: renderCacheSummary({ summary: entry.summary, sourceRef: entry.sourceRef }),
        }].map(normalizeMessage);
        entry.tokenCount = entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
        entry.representation = 'summary+source';
        this._emit('context.compressed', entry, { reason }, JSON.stringify(entry.messages));
        return entry;
    }

    compactToSource(id, reason = 'required-content-too-large') {
        const entry = this.entries.find(candidate => candidate.id === id);
        if (!entry || !entry.messages || entry.messages.length === 0) return null;
        const originalTokenCount = entry.tokenCount;
        const callIds = entry.metadata?.pendingToolCallIds || [];
        const auditRef = this.sessionId && entry.taskRef
            ? `audit:${this.sessionId}:trace:${entry.taskRef}:spans:${callIds.join(',') || entry.spanId}`
            : entry.sourceRef;
        entry.messages = [{
            role: 'system',
            content: renderSourceReference({
                kind: entry.kind,
                sourceRef: auditRef,
                originalTokenCount,
            }),
        }].map(normalizeMessage);
        entry.tokenCount = entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
        entry.representation = 'source-only';
        entry.metadata = {
            ...entry.metadata,
            originalTokenCount,
            compactedForFirstDelivery: true,
            auditRef,
        };
        this._emit('context.compressed', entry, { reason }, JSON.stringify(entry.messages));
        return entry;
    }

    evict(id, reason = 'budget') {
        const entry = this.entries.find(candidate => candidate.id === id);
        if (!entry) return null;
        const members = this.entries.filter(candidate =>
            candidate.atomicGroupId === entry.atomicGroupId
        );
        if (members.some(candidate => candidate.required)) return null;
        for (const member of members) {
            if (!member.resident) continue;
            member.resident = false;
            member.representation = member.summary ? 'summary+source' : 'cold';
            this._emit('context.evicted', member, { reason, atomicGroupId: entry.atomicGroupId });
            if (this._audit && this._loader) member.messages = [];
        }
        return entry;
    }

    residentMessages() {
        return this.entries
            .filter(entry => entry.resident && entry.messages.length > 0)
            .sort((left, right) => left.sequence - right.sequence)
            .flatMap(entry => entry.messages.map(message => normalizeMessage(message)));
    }

    checkpoint() {
        return {
            turn: this.turn,
            openDialogueId: this._openDialogueId,
            openToolSpanId: this._openToolSpanId,
            nodes: this.entries.map(entry => ({
                id: entry.id,
                kind: entry.kind,
                sourceRef: entry.sourceRef,
                taskRef: entry.taskRef,
                spanId: entry.spanId,
                atomicGroupId: entry.atomicGroupId,
                useCount: entry.useCount,
                createdTurn: entry.createdTurn,
                lastUsedTurn: entry.lastUsedTurn,
                tokenCount: entry.tokenCount,
                representation: entry.representation,
                resident: entry.resident,
                required: entry.required,
                sequence: entry.sequence,
                summary: entry.summary,
                metadata: { ...entry.metadata },
            })),
        };
    }

    snapshotEntries() {
        return this.entries.map(entry => ({
            ...entry,
            messages: cloneMessages(entry.messages || []),
            metadata: { ...(entry.metadata || {}) },
        }));
    }

    clear() {
        this.entries = [];
        this._openDialogueId = null;
        this._openToolSpanId = null;
    }
}

module.exports = ContextCache;
