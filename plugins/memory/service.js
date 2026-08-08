const path = require('path');
const { searchArrays } = require('./repository');
const { loadPromptTemplate } = require('../../prompts/loader');

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
        this.context.setTransportOverlay('memory-resume', null);
        this.dirty = true;
    }

    async prepareOverlays() {
        if (this.disposed) return;
        if (this.resumed && this.focus) {
            const content = renderResumeSystem({
                topic: this.focus.topic || '',
                lastResponse: this.focus.lastResponse || '',
                activeFiles: this.focus.activeFiles && this.focus.activeFiles.length
                    ? this.focus.activeFiles.join(', ')
                    : '',
            });
            this.context.setTransportOverlay('memory-resume', {
                priority: 100,
                messages: [{ role: 'system', content }],
            });
        }

        if (this.config.autoRecall === false) return;
        const user = latestMessage(this.context.messages, 'user');
        const query = user && typeof user.content === 'string' ? user.content : '';
        if (!query.trim()) return;
        const recalled = await this.repository.searchMemories(this.ownerFilters('all'), {
            query,
            limit: this.config.autoRecallLimit || 5,
        });
        if (recalled.length === 0) {
            this.context.setTransportOverlay('memory-recall', null);
            return;
        }
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
        this.context.setTransportOverlay('memory-recall', {
            priority: 90,
            messages: [{ role: 'system', content }],
        });
    }

    async searchSessions(options = {}) {
        if ((options.scope || 'current') === 'current') {
            return searchArrays([{
                info: { id: this.context.sessionId, metadata: this.context.metadata },
                messages: this.context.messages,
            }], options);
        }
        return this.repository.searchSessions(this.context.sessionId, options);
    }

    async readSessionRange(options = {}) {
        const sessionId = options.sessionId || this.context.sessionId;
        const start = Math.max(Number(options.start) || 0, 0);
        const end = Math.min(Math.max(Number(options.end) || start + 20, start), start + 100);
        if (sessionId === this.context.sessionId) {
            return this.context.messages.slice(start, end + 1).map((message, offset) => ({
                messageIndex: start + offset,
                role: message.role,
                content: message.content,
                toolCallId: message.tool_call_id || null,
                toolCalls: message.tool_calls || null,
            }));
        }
        return this.repository.readRange(sessionId, start, end);
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
        });
    }

    async searchMemories(options = {}) {
        const scope = ['session', 'project', 'user', 'all'].includes(options.scope)
            ? options.scope
            : 'all';
        return this.repository.searchMemories(this.ownerFilters(scope), options);
    }

    async forget(options = {}) {
        if (!options.id) throw new Error('Memory id is required');
        return this.repository.forget(String(options.id), this.ownerFilters('all'));
    }

    dispose() {
        this.disposed = true;
        this.context.setTransportOverlay('memory-resume', null);
        this.context.setTransportOverlay('memory-recall', null);
    }
}

module.exports = MemoryService;
