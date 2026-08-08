const SystemPrompt = require('./system-prompt');
const { createContextState, DEFAULT_MAX_CONTEXT_TOKENS } = require('./state');
const ops = require('./ops');
const ContextCache = require('./cache');
const tokenController = require('./token-controller');

class Context {
    constructor(systemPromptText, options = {}) {
        this.systemPrompt = new SystemPrompt(systemPromptText);
        this.state = createContextState(options);
        this._resolveExtension = typeof options.resolveExtension === 'function'
            ? options.resolveExtension
            : null;
        this._auditWriter = options.auditWriter || null;
        this._activeTaskRef = null;
        this.cache = new ContextCache({
            sessionId: this.state.sessionId,
            messages: this.state.messages,
            entries: options.cacheEntries,
            turn: options.turn,
            openDialogueId: options.openDialogueId,
            openToolSpanId: options.openToolSpanId,
            loader: options.loadSource,
            audit: event => this._record(event),
        });
        this._syncMessages();
    }

    get sessionId() {
        return this.state.sessionId;
    }

    get metadata() {
        return this.state.metadata;
    }

    set metadata(value) {
        this.state.metadata = value && typeof value === 'object' ? value : {};
    }

    setMaxContextTokens(value) {
        this.state.maxContextTokens = Number.isInteger(value) && value > 0
            ? value
            : DEFAULT_MAX_CONTEXT_TOKENS;
        this.state.lastPreparation = null;
    }

    setModelProfile(profile = {}) {
        this.setMaxContextTokens(profile.maxContextTokens);
        this.state.maxOutputTokens = Number.isInteger(profile.maxOutputTokens) && profile.maxOutputTokens > 0
            ? profile.maxOutputTokens
            : null;
    }

    setAuditWriter(writer) {
        this._auditWriter = writer || null;
    }

    get auditWriter() {
        return this._auditWriter;
    }

    _record(event) {
        if (this._auditWriter && typeof this._auditWriter.record === 'function') {
            this._auditWriter.record(event);
        }
    }

    _syncMessages() {
        this.state.messages = this.cache.residentMessages();
        this.state.totalTokens = null;
    }

    _invalidatePreparation() {
        this.state.lastPreparation = null;
    }

    get messages() {
        this._syncMessages();
        return Object.freeze(this.state.messages.map(message => Object.freeze(ops.normalizeMessage(message))));
    }

    getExtension(name) {
        return this._resolveExtension ? this._resolveExtension(name) : null;
    }

    beginTurn(taskRef = null) {
        const result = this.cache.beginTurn(taskRef);
        this._invalidatePreparation();
        this._syncMessages();
        return result;
    }

    startTask(taskRef) {
        this._activeTaskRef = taskRef || null;
        const latest = [...this.cache.entries].reverse().find(entry =>
            entry.required && entry.messages.some(message => message.role === 'user')
        );
        if (latest && !latest.taskRef) latest.taskRef = this._activeTaskRef;
        return this._activeTaskRef;
    }

    completeTask(taskRef = this._activeTaskRef, reason = 'task-completed') {
        const evicted = this.cache.completeTask(taskRef, reason);
        if (taskRef === this._activeTaskRef) this._activeTaskRef = null;
        this._invalidatePreparation();
        this._syncMessages();
        return evicted;
    }

    addUser(content, options = {}) {
        if (options.beginTurn !== false) this.cache.beginTurn(options.taskRef || null);
        const entry = this.cache.addUser(content, {
            ...options,
            taskRef: options.taskRef || this._activeTaskRef,
        });
        this._invalidatePreparation();
        this._record({
            eventType: options.kind === 'user_instruction' ? 'memory.instruction' : 'dialogue.user',
            actor: 'user',
            spanId: entry.spanId,
            content,
            payload: { cacheNodeId: entry.id, kind: entry.kind },
            tokenCount: entry.tokenCount,
        });
        this._syncMessages();
        return entry.messages[0];
    }

    addAssistant(content, options = {}) {
        const entry = this.cache.addAssistant(content, {
            ...options,
            taskRef: options.taskRef || this._activeTaskRef,
        });
        this._invalidatePreparation();
        this._record({
            eventType: 'dialogue.assistant',
            actor: 'assistant',
            spanId: entry.spanId,
            content,
            payload: { cacheNodeId: entry.id, kind: entry.kind },
            tokenCount: entry.tokenCount,
        });
        this._syncMessages();
        return entry.messages[entry.messages.length - 1];
    }

    addAssistantToolCalls(toolCalls, options = {}) {
        const entry = this.cache.addAssistantToolCalls(toolCalls, {
            ...options,
            taskRef: options.taskRef || this._activeTaskRef,
        });
        this._invalidatePreparation();
        if (!options.auditRecorded) {
            this._record({
                eventType: 'model.tool_calls',
                actor: 'assistant',
                spanId: entry.spanId,
                payload: { cacheNodeId: entry.id, toolCalls },
                tokenCount: entry.tokenCount,
            });
        }
        this._syncMessages();
        return entry.messages[0];
    }

    addToolResult(toolCallId, result, options = {}) {
        const entry = this.cache.addToolResult(toolCallId, result, {
            ...options,
            taskRef: options.taskRef || this._activeTaskRef,
        });
        this._invalidatePreparation();
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        if (!options.auditRecorded) {
            this._record({
                eventType: options.failed ? 'tool.failed' : 'tool.result',
                actor: options.toolName || 'tool',
                spanId: entry.spanId,
                content,
                payload: {
                    cacheNodeId: entry.id,
                    toolCallId,
                    toolName: options.toolName || null,
                    kind: options.kind || entry.kind,
                },
                tokenCount: ops.estimateTokens({ role: 'tool', content }),
            });
        }
        this._syncMessages();
        return entry.messages[entry.messages.length - 1];
    }

    load(value, options = {}) {
        const entry = this.cache.load(value, {
            ...options,
            taskRef: options.taskRef || this._activeTaskRef,
        });
        this._invalidatePreparation();
        this._syncMessages();
        return entry;
    }

    async restore(id, reason) {
        const entry = await this.cache.restore(id, reason);
        this._invalidatePreparation();
        this._syncMessages();
        return entry;
    }

    touch(id, reason) {
        const entry = this.cache.touch(id, reason);
        if (entry) this._invalidatePreparation();
        return entry;
    }

    evict(id, reason) {
        const entry = this.cache.evict(id, reason);
        if (entry) this._invalidatePreparation();
        this._syncMessages();
        return entry;
    }

    prepareRequest({ tools = [], modelProfile = {} } = {}) {
        const prepared = tokenController.prepare(this.cache, this.systemPrompt.toMessage(), {
            tools,
            modelProfile: {
                maxContextTokens: modelProfile.maxContextTokens || this.state.maxContextTokens,
                maxOutputTokens: modelProfile.maxOutputTokens || this.state.maxOutputTokens,
                countTokens: modelProfile.countTokens,
            },
            maxContextTokens: this.state.maxContextTokens,
            safetyMargin: this.state.safetyMargin,
        });
        this.state.lastPreparation = prepared.usage;
        this._syncMessages();
        return prepared;
    }

    getMessages() {
        return this.prepareRequest().messages;
    }

    usage() {
        if (this.state.lastPreparation) {
            const latest = this.state.lastPreparation;
            return {
                ...latest,
                used: latest.requestTokens,
                history: Object.values(latest.byType || {}).reduce((sum, value) => sum + value, 0),
                system: latest.systemTokens,
                limit: latest.window,
                messageCount: this.state.messages.length,
            };
        }
        const legacy = ops.usage(this.state, this.systemPrompt.toMessage());
        return {
            ...legacy,
            outputReserve: this.state.maxOutputTokens,
            byType: {},
            residentNodes: this.cache.entries.filter(entry => entry.resident).length,
            coldNodes: this.cache.entries.filter(entry => !entry.resident).length,
            reductionReasons: [],
        };
    }

    snapshotMessages() {
        this._syncMessages();
        return ops.snapshotMessages(this.state);
    }

    checkpoint() {
        return this.cache.checkpoint();
    }

    snapshotCacheEntries() {
        return this.cache.snapshotEntries();
    }

    clear() {
        this.cache.clear();
        ops.clear(this.state);
        this._invalidatePreparation();
    }
}

module.exports = Context;
