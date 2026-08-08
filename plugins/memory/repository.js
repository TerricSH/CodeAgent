const {
    ensureRuntimeDatabase,
    withRuntimeTransaction,
} = require('../../data-layer/postgres/runtime-db');

function parseJson(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function toIso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
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
                timestamp: toIso(message.created_at || message.timestamp),
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

function mapMessage(row) {
    return {
        ...row,
        message_index: Number(row.message_index),
        timestamp: toIso(row.timestamp),
        created_at: toIso(row.created_at),
        finished_at: toIso(row.finished_at),
        tool_calls: parseJson(row.tool_calls, null),
        metadata: parseJson(row.metadata, null),
    };
}

class MemoryRepository {
    async sessionRows() {
        const { pool, sql: schema } = await ensureRuntimeDatabase();
        const result = await pool.query(`
            SELECT id, start_time, end_time, metadata
            FROM ${schema}.sessions
            ORDER BY start_time DESC
        `);
        return result.rows.map((row) => ({
            id: row.id,
            startTime: toIso(row.start_time),
            endTime: toIso(row.end_time),
            metadata: parseJson(row.metadata, {}),
        }));
    }

    async resolveSessionIds(currentSessionId, scope = 'current', specificSessionId = null) {
        if (scope === 'specific') return specificSessionId ? [specificSessionId] : [];
        if (scope === 'current') return currentSessionId ? [currentSessionId] : [];
        const rows = await this.sessionRows();
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

    async loadSessions(ids) {
        if (!ids || ids.length === 0) return [];
        const { pool, sql: schema } = await ensureRuntimeDatabase();
        const sessionResult = await pool.query(`
            SELECT id, start_time, end_time, metadata
            FROM ${schema}.sessions
            WHERE id = ANY($1::text[])
        `, [ids]);
        const messageResult = await pool.query(`
            SELECT session_id, role, content, timestamp, created_at, finished_at, message_index,
                   tool_call_id, tool_calls, metadata
            FROM ${schema}.messages
            WHERE session_id = ANY($1::text[])
            ORDER BY session_id, message_index
        `, [ids]);
        const messagesBySession = new Map();
        for (const row of messageResult.rows) {
            if (!messagesBySession.has(row.session_id)) messagesBySession.set(row.session_id, []);
            messagesBySession.get(row.session_id).push(mapMessage(row));
        }
        const rowsById = new Map(sessionResult.rows.map(row => [row.id, row]));
        return ids.filter(id => rowsById.has(id)).map((id) => {
            const row = rowsById.get(id);
            return {
                info: {
                    id: row.id,
                    startTime: toIso(row.start_time),
                    endTime: toIso(row.end_time),
                    metadata: parseJson(row.metadata, {}),
                },
                messages: messagesBySession.get(id) || [],
            };
        });
    }

    async searchSessions(currentSessionId, options = {}) {
        const ids = await this.resolveSessionIds(currentSessionId, options.scope, options.sessionId);
        return searchArrays(await this.loadSessions(ids), options);
    }

    async readRange(sessionId, start = 0, end = 20) {
        const from = Math.max(Number(start) || 0, 0);
        const to = Math.max(Number(end) || from + 20, from);
        const { pool, sql: schema } = await ensureRuntimeDatabase();
        const result = await pool.query(`
            SELECT role, content, timestamp, created_at, finished_at, message_index,
                   tool_call_id, tool_calls, metadata
            FROM ${schema}.messages
            WHERE session_id = $1 AND message_index >= $2 AND message_index <= $3
            ORDER BY message_index
        `, [sessionId, from, to]);
        return result.rows.map((row) => ({
            ...mapMessage(row),
            content: clip(row.content, 4000),
        }));
    }

    async remember(record) {
        return withRuntimeTransaction(async (client, { sql: schema }) => {
            const now = new Date().toISOString();
            const id = globalThis.crypto.randomUUID();
            let supersedes = null;
            if (record.subject) {
                await client.query(
                    'SELECT pg_advisory_xact_lock(hashtext($1))',
                    [`codeagent-memory:${record.scope}:${record.ownerKey}:${record.subject}`]
                );
                const previousResult = await client.query(`
                    SELECT id, content FROM ${schema}.memories
                    WHERE scope = $1 AND owner_key = $2 AND subject = $3 AND status = 'active'
                    ORDER BY updated_at DESC LIMIT 1
                    FOR UPDATE
                `, [record.scope, record.ownerKey, record.subject]);
                const previous = previousResult.rows[0];
                if (previous && previous.content === record.content) return previous.id;
                if (previous) {
                    supersedes = previous.id;
                    await client.query(`
                        UPDATE ${schema}.memories
                        SET status = 'superseded', updated_at = $1
                        WHERE id = $2
                    `, [now, previous.id]);
                }
            }
            await client.query(`
                INSERT INTO ${schema}.memories (
                    id, scope, owner_key, type, subject, content, importance, confidence,
                    status, source_session_id, source_message_indexes, supersedes, tags,
                    metadata, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10::jsonb,
                    $11, $12::jsonb, $13::jsonb, $14, $14
                )
            `, [
                id,
                record.scope,
                record.ownerKey,
                record.type,
                record.subject || null,
                record.content,
                record.importance,
                record.confidence,
                record.sourceSessionId || null,
                JSON.stringify(record.sourceMessageIndexes || []),
                supersedes,
                JSON.stringify(record.tags || []),
                JSON.stringify(record.metadata || {}),
                now,
            ]);
            return id;
        });
    }

    async searchMemories(ownerFilters, options = {}) {
        const terms = normalizeTerms(options.query, options.keywords);
        const { pool, sql: schema } = await ensureRuntimeDatabase();
        const rows = [];
        for (const filter of ownerFilters) {
            const result = await pool.query(`
                SELECT * FROM ${schema}.memories
                WHERE scope = $1 AND owner_key = $2 AND status = 'active'
                ORDER BY importance DESC, updated_at DESC
            `, [filter.scope, filter.ownerKey]);
            rows.push(...result.rows);
        }
        const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
        const matched = rows.filter((row) => {
            if (terms.length === 0) return true;
            return matches(`${row.subject || ''}\n${row.content}\n${JSON.stringify(row.tags || [])}`, terms, 'any');
        }).slice(0, limit);
        if (matched.length > 0) {
            await pool.query(`
                UPDATE ${schema}.memories
                SET access_count = access_count + 1, last_accessed_at = $1
                WHERE id = ANY($2::text[])
            `, [new Date().toISOString(), matched.map((row) => row.id)]);
        }
        return matched.map((row) => ({
            id: row.id,
            scope: row.scope,
            type: row.type,
            subject: row.subject,
            content: row.content,
            importance: Number(row.importance),
            confidence: Number(row.confidence),
            sourceSessionId: row.source_session_id,
            tags: parseJson(row.tags, []),
            updatedAt: toIso(row.updated_at),
        }));
    }

    async forget(id, ownerFilters) {
        const allowed = ownerFilters.map((item) => [item.scope, item.ownerKey]);
        if (allowed.length === 0) return false;
        const { pool, sql: schema } = await ensureRuntimeDatabase();
        const params = [id, new Date().toISOString()];
        const clauses = allowed.map(([scope, ownerKey]) => {
            params.push(scope, ownerKey);
            return `(scope = $${params.length - 1} AND owner_key = $${params.length})`;
        });
        const result = await pool.query(`
            UPDATE ${schema}.memories
            SET status = 'forgotten', updated_at = $2
            WHERE id = $1 AND (${clauses.join(' OR ')})
        `, params);
        return result.rowCount > 0;
    }
}

module.exports = { MemoryRepository, searchArrays };
