const path = require('path');
const { loadPromptTemplate } = require('../../prompts/loader');
const auditRepository = require('../../data-layer/repositories/audit-repository');

const renderResumeSystem = loadPromptTemplate(path.join(__dirname, 'prompts', 'resume-system.md'));
const renderRecallSystem = loadPromptTemplate(path.join(__dirname, 'prompts', 'recall-system.md'));
const renderRecallItem = loadPromptTemplate(path.join(__dirname, 'prompts', 'recall-item.md'));

const STATE_VERSION = 1;

function boundedNumber(value, fallback, min = 0, max = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function latestMessage(messages, role) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === role) return messages[index];
    }
    return null;
}

function extractFiles(messages) {
    const found = new Set();
    const extensions = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|go|rs|java|sql|yml|yaml|toml|env)(?::\d+)?$/i;
    for (const message of messages.slice(-16)) {
        const values = [message.content, message.tool_calls];
        for (const value of values) {
            const text = typeof value === 'string' ? value : JSON.stringify(value || '');
            for (const raw of text.split(/\s+/)) {
                const token = raw.replace(/^[`'"([{]+|[`'"\])},;]+$/g, '');
                if ((token.includes('/') || token.includes('\\')) && extensions.test(token)) {
                    found.add(token);
                } else if (extensions.test(path.basename(token)) && token.length < 240) {
                    found.add(token);
                }
                if (found.size >= 12) return [...found];
            }
        }
    }
    return [...found];
}

function safeMemoryContent(content) {
    const text = String(content || '').trim();
    if (!text) throw new Error('Memory content is required');
    if (/(api[_ -]?key|access[_ -]?token|password|private[_ -]?key)\s*[:=]\s*\S+/i.test(text)) {
        throw new Error('Refusing to store content that appears to contain credentials');
    }
    return text;
}

class MemoryService {
    constructor(context, repository, config = {}) {
        this.context = context;
        this.repository = repository;
        this.config = config;
        this.focus = null;
        this.resumed = false;
        this.dirty = false;
        this.disposed = false;
        this.resumeNodeId = null;
        this.recallNodes = new Map();
        this.projectKey = config.projectKey
            || (context.metadata && context.metadata.projectId)
            || process.cwd();
        this.userKey = config.userKey
            || (context.metadata && context.metadata.userId)
            || 'default';
    }

    ownerFilter(scope) {
        if (scope === 'session') return { scope, ownerKey: this.context.sessionId };
        if (scope === 'user') return { scope, ownerKey: this.userKey };
        return { scope: 'project', ownerKey: this.projectKey };
    }

    ownerFilters(scope = 'all') {
        if (scope !== 'all') return [this.ownerFilter(scope)];
        return [this.ownerFilter('session'), this.ownerFilter('project'), this.ownerFilter('user')];
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || envelope.version !== STATE_VERSION) {
            throw new Error('Invalid memory plugin state envelope');
        }
        this.focus = envelope.focus || null;
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({ version: STATE_VERSION, focus: this.focus });
    }

    markResumed() {
        this.resumed = true;
    }

    updateFocus() {
        const messages = this.context.messages;
        const user = latestMessage(messages, 'user');
        const assistant = latestMessage(messages, 'assistant');
        this.focus = {
            topic: user && typeof user.content === 'string' ? user.content.slice(0, 320) : null,
            lastResponse: assistant && typeof assistant.content === 'string'
                ? assistant.content.slice(0, 500)
                : null,
            activeFiles: extractFiles(messages),
            messageCount: messages.length,
            updatedAt: new Date().toISOString(),
        };
        this.resumed = false;
        this.dirty = true;
    }

    ragEventSink(eventType, payload) {
        const writer = this.context.auditWriter;
        if (!writer) return;
        writer.record({
            eventType,
            actor: 'history-rag',
            payload,
        });
    }

    cachedRecall(query, domain) {
        const key = `${domain}:${query}`;
        const id = this.recallNodes.get(key);
        if (!id) return null;
        const entry = this.context.cache.entries.find(candidate => candidate.id === id && candidate.resident);
        if (!entry) return null;
        this.context.touch(id, 'memory-cache-hit');
        return entry.metadata.result || null;
    }

    cacheRecall(query, domain, result) {
        const entry = this.context.load({
            role: 'system',
            content: JSON.stringify(result),
            kind: 'history_result',
            sourceRef: `history-rag:${domain}:${globalThis.crypto.randomUUID()}`,
            metadata: { query, domain, result },
        });
        this.recallNodes.set(`${domain}:${query}`, entry.id);
        return result;
    }

    async prepareContext() {
        if (this.disposed) return;
        if (this.resumed && this.focus) {
            const content = renderResumeSystem({
                topic: this.focus.topic || '',
                lastResponse: this.focus.lastResponse || '',
                activeFiles: this.focus.activeFiles && this.focus.activeFiles.length
                    ? this.focus.activeFiles.join(', ')
                    : '',
            });
            if (this.resumeNodeId) this.context.touch(this.resumeNodeId, 'session-resume');
            else {
                this.resumeNodeId = this.context.load({
                    role: 'system',
                    content,
                    kind: 'history_result',
                    sourceRef: `memory-focus:${this.context.sessionId}`,
                }).id;
            }
        }

        if (this.config.autoRecall === false) return;
        const user = latestMessage(this.context.messages, 'user');
        const query = user && typeof user.content === 'string' ? user.content : '';
        if (!query.trim()) return;
        const recalled = await this.searchMemories({
            query,
            limit: this.config.autoRecallLimit || 5,
            scope: 'all',
        });
        if (recalled.length === 0) return;
        const content = renderRecallSystem({
            memoryItems: recalled
                .map((item) => renderRecallItem({
                    id: item.id,
                    scope: item.scope,
                    type: item.type,
                    content: item.content,
                }))
                .join('\n'),
        });
        this.context.load({
            role: 'system',
            content,
            kind: 'history_result',
            sourceRef: `memory-recall:${globalThis.crypto.randomUUID()}`,
            metadata: { query, result: recalled },
        });
    }

    async searchSessions(options = {}) {
        const query = String(options.query || (options.keywords || []).join(' ')).trim();
        if (!query) throw new Error('Session history search requires query or keywords');
        const cached = this.cachedRecall(query, 'session');
        if (cached) return cached;
        const sessionIds = await this.repository.resolveSessionIds(
            this.context.sessionId,
            options.scope || 'current',
            options.sessionId
        );
        const result = await this.repository.historyRag.search({
            sessionIds,
            query,
            limit: options.limit,
            eventSink: (type, payload) => this.ragEventSink(type, payload),
        });
        this.ragEventSink('memory.recalled', { query, count: result.count, sessionIds });
        return this.cacheRecall(query, 'session', result);
    }

    // Compatibility alias for integrations built before node-based Context loading.
    async prepareOverlays() {
        return this.prepareContext();
    }

    async readSessionRange(options = {}) {
        const sessionId = options.sessionId || this.context.sessionId;
        const start = Math.max(Number(options.start) || 1, 1);
        const end = Math.min(Math.max(Number(options.end) || start + 20, start), start + 500);
        const allowed = await this.repository.resolveSessionIds(
            this.context.sessionId,
            'specific',
            sessionId
        );
        if (allowed.length === 0 && sessionId !== this.context.sessionId) {
            throw new Error('Requested session is outside the authorized parent/child session tree');
        }
        return auditRepository.readEvents({ sessionId, fromSequence: start, toSequence: end, limit: 500 });
    }

    async remember(options = {}) {
        const scope = ['session', 'project', 'user'].includes(options.scope) ? options.scope : 'project';
        if (this.context.metadata && this.context.metadata.type === 'subagent' && scope !== 'session') {
            throw new Error('Subagents may only write session-scoped memory; return project memory candidates to the parent agent');
        }
        const type = ['working', 'episodic', 'semantic'].includes(options.type)
            ? options.type
            : 'semantic';
        return this.repository.remember({
            ...this.ownerFilter(scope),
            type,
            subject: options.subject ? String(options.subject).trim() : null,
            content: safeMemoryContent(options.content),
            importance: boundedNumber(options.importance, 0.5),
            confidence: boundedNumber(options.confidence, 1),
            sourceSessionId: this.context.sessionId,
            sourceMessageIndexes: Array.isArray(options.sourceMessageIndexes)
                ? options.sourceMessageIndexes.filter(Number.isInteger)
                : [],
            tags: Array.isArray(options.tags) ? options.tags.map(String).slice(0, 20) : [],
            metadata: { createdBySessionType: this.context.metadata && this.context.metadata.type || 'main' },
            traceId: this.context.auditWriter?.activeTraceId || null,
            checkpoint: this.context.checkpoint(),
            auditWriter: this.context.auditWriter,
        });
    }

    async searchMemories(options = {}) {
        const scope = ['session', 'project', 'user', 'all'].includes(options.scope)
            ? options.scope
            : 'all';
        const query = String(options.query || (options.keywords || []).join(' ')).trim();
        if (!query) throw new Error('Memory search requires query or keywords');
        const cached = this.cachedRecall(query, `memory:${scope}`);
        if (cached) return cached;
        const result = await this.repository.searchMemories(this.ownerFilters(scope), {
            ...options,
            query,
            eventSink: (type, payload) => this.ragEventSink(type, payload),
        });
        this.ragEventSink('memory.recalled', { query, count: result.length, scope });
        return this.cacheRecall(query, `memory:${scope}`, result);
    }

    async forget(options = {}) {
        if (!options.id) throw new Error('Memory id is required');
        return this.repository.forget(String(options.id), this.ownerFilters('all'), {
            sessionId: this.context.sessionId,
            traceId: this.context.auditWriter?.activeTraceId || null,
            checkpoint: this.context.checkpoint(),
            auditWriter: this.context.auditWriter,
        });
    }

    dispose() {
        this.disposed = true;
    }
}

module.exports = MemoryService;
