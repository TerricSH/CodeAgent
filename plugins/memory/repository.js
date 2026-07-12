const { getDb } = require('../../data-layer/sqlite/db');

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function clip(value, max = 2000) {
    const text = value == null ? '' : String(value);
    return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function normalizeTerms(query, keywords) {
    const values = Array.isArray(keywords) && keywords.length > 0 ? keywords : [query];
    return values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function messageText(message) {
    return [message.content, message.tool_calls, message.tool_call_id]
        .filter((value) => value != null)
        .map((value) => typeof value === 'string' ? value : JSON.stringify(value))
        .join('\n');
}

function matches(text, terms, mode) {
    const source = text.toLowerCase();
    if (terms.length === 0) return false;
    if (mode === 'exact') return source.includes(terms.join(' '));
    if (mode === 'all') return terms.every((term) => source.includes(term));
    return terms.some((term) => source.includes(term));
}

function searchArrays(sessions, options = {}) {
    const terms = normalizeTerms(options.query, options.keywords);
    const mode = options.mode === 'all' || options.mode === 'exact' ? options.mode : 'any';
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
    const around = Math.min(Math.max(Number(options.around) || 2, 0), 5);
    const role = options.role || null;
    const hits = [];

    for (const session of sessions) {
        const messages = session.messages || [];
        for (let index = 0; index < messages.length && hits.length < limit; index += 1) {
            const message = messages[index];
            if (role && message.role !== role) continue;
            if (!matches(messageText(message), terms, mode)) continue;
            hits.push({
                session: session.info,
                messageIndex: message.message_index != null ? message.message_index : index,
                role: message.role,
                timestamp: message.created_at || message.timestamp || null,
                content: clip(message.content),
                context: messages.slice(Math.max(0, index - around), index + around + 1).map((item, offset) => ({
                    messageIndex: item.message_index != null
                        ? item.message_index
                        : Math.max(0, index - around) + offset,
                    role: item.role,
                    content: clip(item.content, 1200),
                    toolCallId: item.tool_call_id || null,
                    toolCalls: item.tool_calls || null,
                })),
            });
        }
        if (hits.length >= limit) break;
    }
    return { query: options.query || null, keywords: terms, count: hits.length, hits };
}

class MemoryRepository {
    constructor() {
        this.db = getDb();
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                owner_key TEXT NOT NULL,
                type TEXT NOT NULL,
                subject TEXT,
                content TEXT NOT NULL,
                importance REAL NOT NULL DEFAULT 0.5,
                confidence REAL NOT NULL DEFAULT 1.0,
                status TEXT NOT NULL DEFAULT 'active',
                source_session_id TEXT,
                source_message_indexes TEXT,
                supersedes TEXT,
                tags TEXT,
                metadata TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_accessed_at TEXT,
                access_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_memories_owner_status
                ON memories(scope, owner_key, status);
            CREATE INDEX IF NOT EXISTS idx_memories_subject
                ON memories(scope, owner_key, subject);
        `);
    }

    sessionRows() {
        return this.db.prepare('SELECT id, start_time, end_time, metadata FROM sessions ORDER BY start_time DESC').all()
            .map((row) => ({
                id: row.id,
                startTime: row.start_time,
                endTime: row.end_time,
                metadata: parseJson(row.metadata, {}),
            }));
    }

    resolveSessionIds(currentSessionId, scope = 'current', specificSessionId = null) {
        if (scope === 'specific') return specificSessionId ? [specificSessionId] : [];
        if (scope === 'current') return currentSessionId ? [currentSessionId] : [];
        const rows = this.sessionRows();
        const children = new Map();
        for (const row of rows) {
            const parent = row.metadata && row.metadata.parentSessionId;
            if (!parent) continue;
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(row.id);
        }
        const direct = children.get(currentSessionId) || [];
        if (scope === 'children') return direct;
        const descendants = [];
        const queue = [...direct];
        const seen = new Set();
        while (queue.length > 0) {
            const id = queue.shift();
            if (seen.has(id)) continue;
            seen.add(id);
            descendants.push(id);
            queue.push(...(children.get(id) || []));
        }
        return scope === 'session_tree'
            ? [currentSessionId, ...descendants].filter(Boolean)
            : descendants;
    }

    loadSessions(ids) {
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(', ');
        const sessionRows = this.db.prepare(
            `SELECT id, start_time, end_time, metadata FROM sessions WHERE id IN (${placeholders})`
        ).all(...ids);
        const messageStmt = this.db.prepare(`
            SELECT role, content, timestamp, created_at, finished_at, message_index,
                   tool_call_id, tool_calls, metadata
            FROM messages WHERE session_id = ? ORDER BY message_index
        `);
        return sessionRows.map((row) => ({
            info: {
                id: row.id,
                startTime: row.start_time,
                endTime: row.end_time,
                metadata: parseJson(row.metadata, {}),
            },
            messages: messageStmt.all(row.id).map((message) => ({
                ...message,
                tool_calls: parseJson(message.tool_calls, null),
                metadata: parseJson(message.metadata, null),
            })),
        }));
    }

    searchSessions(currentSessionId, options = {}) {
        const ids = this.resolveSessionIds(currentSessionId, options.scope, options.sessionId);
        return searchArrays(this.loadSessions(ids), options);
    }

    readRange(sessionId, start = 0, end = 20) {
        const from = Math.max(Number(start) || 0, 0);
        const to = Math.max(Number(end) || from + 20, from);
        return this.db.prepare(`
            SELECT role, content, timestamp, created_at, finished_at, message_index,
                   tool_call_id, tool_calls, metadata
            FROM messages
            WHERE session_id = ? AND message_index >= ? AND message_index <= ?
            ORDER BY message_index
        `).all(sessionId, from, to).map((row) => ({
            ...row,
            tool_calls: parseJson(row.tool_calls, null),
            metadata: parseJson(row.metadata, null),
            content: clip(row.content, 4000),
        }));
    }

    remember(record) {
        const now = new Date().toISOString();
        const id = globalThis.crypto.randomUUID();
        let supersedes = null;
        if (record.subject) {
            const previous = this.db.prepare(`
                SELECT id, content FROM memories
                WHERE scope = ? AND owner_key = ? AND subject = ? AND status = 'active'
                ORDER BY updated_at DESC LIMIT 1
            `).get(record.scope, record.ownerKey, record.subject);
            if (previous && previous.content === record.content) return previous.id;
            if (previous) {
                supersedes = previous.id;
                this.db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?")
                    .run(now, previous.id);
            }
        }
        this.db.prepare(`
            INSERT INTO memories (
                id, scope, owner_key, type, subject, content, importance, confidence,
                status, source_session_id, source_message_indexes, supersedes, tags,
                metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, record.scope, record.ownerKey, record.type, record.subject || null,
            record.content, record.importance, record.confidence,
            record.sourceSessionId || null, JSON.stringify(record.sourceMessageIndexes || []),
            supersedes, JSON.stringify(record.tags || []), JSON.stringify(record.metadata || {}),
            now, now
        );
        return id;
    }

    searchMemories(ownerFilters, options = {}) {
        const terms = normalizeTerms(options.query, options.keywords);
        const rows = [];
        for (const filter of ownerFilters) {
            rows.push(...this.db.prepare(`
                SELECT * FROM memories
                WHERE scope = ? AND owner_key = ? AND status = 'active'
                ORDER BY importance DESC, updated_at DESC
            `).all(filter.scope, filter.ownerKey));
        }
        const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
        const matched = rows.filter((row) => {
            if (terms.length === 0) return true;
            return matches(`${row.subject || ''}\n${row.content}\n${row.tags || ''}`, terms, 'any');
        }).slice(0, limit);
        const now = new Date().toISOString();
        const touch = this.db.prepare(`
            UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
        `);
        for (const row of matched) touch.run(now, row.id);
        return matched.map((row) => ({
            id: row.id,
            scope: row.scope,
            type: row.type,
            subject: row.subject,
            content: row.content,
            importance: row.importance,
            confidence: row.confidence,
            sourceSessionId: row.source_session_id,
            tags: parseJson(row.tags, []),
            updatedAt: row.updated_at,
        }));
    }

    forget(id, ownerFilters) {
        const allowed = new Set(ownerFilters.map((item) => `${item.scope}:${item.ownerKey}`));
        const row = this.db.prepare('SELECT scope, owner_key FROM memories WHERE id = ?').get(id);
        if (!row || !allowed.has(`${row.scope}:${row.owner_key}`)) return false;
        this.db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), id);
        return true;
    }
}

module.exports = { MemoryRepository, searchArrays };
