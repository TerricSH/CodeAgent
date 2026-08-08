const { withRuntimeTransaction, ensureRuntimeDatabase } = require('../../data-layer/postgres/runtime-db');
const auditRepository = require('../../data-layer/repositories/audit-repository');
const HistoryRagService = require('../../rag-core/history-service');
const { HistoryAdapter } = require('../../rag-core/adapters');

function parseJson(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function toIso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

class MemoryRepository {
    constructor(options = {}) {
        this.historyRag = options.historyRag || new HistoryRagService(options.historyOptions);
        this.historyAdapter = options.historyAdapter || new HistoryAdapter();
    }

    async sessionRows() {
        const { pool, sql: schema } = await ensureRuntimeDatabase();
        const result = await pool.query(`
            SELECT id, start_time, end_time, metadata
            FROM ${schema}.sessions
            ORDER BY start_time DESC
        `);
        return result.rows.map(row => ({
            id: row.id,
            startTime: toIso(row.start_time),
            endTime: toIso(row.end_time),
            metadata: parseJson(row.metadata, {}),
        }));
    }

    async resolveSessionIds(currentSessionId, scope = 'current', specificSessionId = null) {
        if (scope === 'current') return currentSessionId ? [currentSessionId] : [];
        const rows = await this.sessionRows();
        const children = new Map();
        const parent = new Map();
        for (const row of rows) {
            const parentId = row.metadata?.parentSessionId;
            if (!parentId) continue;
            parent.set(row.id, parentId);
            if (!children.has(parentId)) children.set(parentId, []);
            children.get(parentId).push(row.id);
        }
        const descendants = [];
        const queue = [...(children.get(currentSessionId) || [])];
        const seen = new Set();
        while (queue.length > 0) {
            const id = queue.shift();
            if (seen.has(id)) continue;
            seen.add(id);
            descendants.push(id);
            queue.push(...(children.get(id) || []));
        }
        if (scope === 'children') return children.get(currentSessionId) || [];
        if (scope === 'descendants') return descendants;
        const ancestors = [];
        let cursor = parent.get(currentSessionId);
        while (cursor && !ancestors.includes(cursor)) {
            ancestors.push(cursor);
            cursor = parent.get(cursor);
        }
        const tree = [currentSessionId, ...ancestors, ...descendants].filter(Boolean);
        if (scope === 'specific') return specificSessionId && tree.includes(specificSessionId)
            ? [specificSessionId]
            : [];
        return tree;
    }

    async remember(record) {
        return withRuntimeTransaction(async (client, { sql: schema }) => {
            const now = new Date().toISOString();
            const id = globalThis.crypto.randomUUID();
            let supersedes = null;
            if (record.subject) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                    `codeagent-memory:${record.scope}:${record.ownerKey}:${record.subject}`,
                ]);
                const previousResult = await client.query(`
                    SELECT id, content FROM ${schema}.memories
                    WHERE scope = $1 AND owner_key = $2 AND subject = $3 AND status = 'active'
                    ORDER BY updated_at DESC LIMIT 1 FOR UPDATE
                `, [record.scope, record.ownerKey, record.subject]);
                const previous = previousResult.rows[0];
                if (previous && previous.content === record.content) return previous.id;
                if (previous) {
                    supersedes = previous.id;
                    await client.query(`
                        UPDATE ${schema}.memories SET status = 'superseded', updated_at = $1
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
                id, record.scope, record.ownerKey, record.type, record.subject || null,
                record.content, record.importance, record.confidence,
                record.sourceSessionId || null, JSON.stringify(record.sourceMessageIndexes || []),
                supersedes, JSON.stringify(record.tags || []), JSON.stringify(record.metadata || {}), now,
            ]);
            if (record.sourceSessionId) {
                const event = {
                    traceId: record.traceId || null,
                    eventType: 'memory.remembered',
                    actor: 'memory',
                    content: record.content,
                    payload: {
                        memoryId: id,
                        scope: record.scope,
                        ownerKey: record.ownerKey,
                        type: record.type,
                        subject: record.subject || null,
                        importance: record.importance,
                        confidence: record.confidence,
                        tags: record.tags || [],
                        supersedes,
                    },
                };
                if (record.auditWriter) {
                    await record.auditWriter.appendTransactional(event, record.checkpoint, client);
                } else {
                    await auditRepository.appendEvents(record.sourceSessionId, [event], {
                        client,
                        checkpoint: record.checkpoint,
                    });
                }
            }
            return id;
        });
    }

    async searchMemories(ownerFilters, options = {}) {
        const collections = ownerFilters.map(filter =>
            this.historyAdapter.memoryCollection(filter.scope, filter.ownerKey)
        );
        const result = await this.historyRag.search({
            query: options.query || (options.keywords || []).join(' '),
            collections,
            limit: options.limit,
            indexAll: true,
            eventSink: options.eventSink,
        });
        return result.hits.map(hit => ({
            id: hit.metadata?.memoryId || null,
            scope: hit.metadata?.memory?.scope || null,
            type: hit.metadata?.memory?.type || null,
            subject: hit.metadata?.memory?.subject || null,
            content: hit.content,
            importance: hit.metadata?.memory?.importance ?? null,
            confidence: hit.metadata?.memory?.confidence ?? null,
            sourceSessionId: hit.metadata?.sessionId || null,
            tags: hit.metadata?.memory?.tags || [],
            auditRef: {
                sessionId: hit.metadata?.sessionId,
                sequence: hit.metadata?.sequence,
                traceId: hit.metadata?.traceId,
            },
            rerankScore: hit.rerankScore,
        }));
    }

    async forget(id, ownerFilters, options = {}) {
        const allowed = ownerFilters.map(item => [item.scope, item.ownerKey]);
        if (allowed.length === 0) return false;
        return withRuntimeTransaction(async (client, { sql: schema }) => {
            const params = [id, new Date().toISOString()];
            const clauses = allowed.map(([scope, ownerKey]) => {
                params.push(scope, ownerKey);
                return `(scope = $${params.length - 1} AND owner_key = $${params.length})`;
            });
            const result = await client.query(`
                UPDATE ${schema}.memories SET status = 'forgotten', updated_at = $2
                WHERE id = $1 AND (${clauses.join(' OR ')})
                RETURNING source_session_id
            `, params);
            if (result.rowCount === 0) return false;
            const sessionId = options.sessionId || result.rows[0].source_session_id;
            if (sessionId) {
                const event = {
                    traceId: options.traceId || null,
                    eventType: 'memory.forgotten',
                    actor: 'memory',
                    content: id,
                    payload: {
                        memoryId: id,
                        owners: ownerFilters.map(filter => ({
                            scope: filter.scope,
                            ownerKey: filter.ownerKey,
                        })),
                    },
                };
                if (options.auditWriter) {
                    await options.auditWriter.appendTransactional(event, options.checkpoint, client);
                } else {
                    await auditRepository.appendEvents(sessionId, [event], {
                        client,
                        checkpoint: options.checkpoint,
                    });
                }
            }
            return true;
        });
    }
}

module.exports = { MemoryRepository };
