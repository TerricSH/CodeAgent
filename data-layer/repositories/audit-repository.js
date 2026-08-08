const crypto = require('node:crypto');
const { ensureRuntimeDatabase, withRuntimeTransaction } = require('../postgres/runtime-db');

const LARGE_CONTENT_BYTES = 16 * 1024;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
    }, {});
}

function stableStringify(value) {
    return JSON.stringify(stableValue(value));
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function toIso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function canonicalIso(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid Audit timestamp: ${value}`);
    return date.toISOString();
}

function parseJson(value, fallback = null) {
    if (value == null || typeof value === 'object') return value ?? fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function mapEvent(row, blobContent = null) {
    return {
        id: row.id,
        sessionId: row.session_id,
        sequence: Number(row.sequence),
        traceId: row.trace_id,
        spanId: row.span_id,
        parentSpanId: row.parent_span_id,
        eventType: row.event_type,
        actor: row.actor,
        content: row.content == null ? blobContent : row.content,
        payload: parseJson(row.payload, {}),
        blobRef: row.blob_ref,
        tokenCount: row.token_count == null ? null : Number(row.token_count),
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
        createdAt: toIso(row.created_at),
    };
}

function eventHash(record) {
    return sha256(stableStringify({
        sessionId: record.sessionId,
        sequence: record.sequence,
        traceId: record.traceId || null,
        spanId: record.spanId || null,
        parentSpanId: record.parentSpanId || null,
        eventType: record.eventType,
        actor: record.actor || null,
        content: record.content == null ? null : String(record.content),
        payload: record.payload || {},
        blobRef: record.blobRef || null,
        tokenCount: record.tokenCount ?? null,
        previousHash: record.previousHash || null,
        createdAt: record.createdAt,
    }));
}

async function appendEvents(sessionId, events, options = {}) {
    if (!sessionId) throw new Error('Audit sessionId is required');
    if (!Array.isArray(events)) throw new TypeError('Audit events must be an array');
    if (events.length === 0 && options.checkpoint === undefined) return [];

    const operation = async (client, { sql: schema }) => {
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`codeagent-audit-session:${sessionId}`]
        );
        await client.query(`
            INSERT INTO ${schema}.sessions (id, start_time, end_time, metadata)
            VALUES ($1, $2, NULL, '{}'::jsonb)
            ON CONFLICT (id) DO NOTHING
        `, [sessionId, new Date().toISOString()]);
        if (options.sessionState && typeof options.sessionState === 'object') {
            await client.query(`
                UPDATE ${schema}.sessions
                SET metadata = $2::jsonb
                WHERE id = $1
            `, [sessionId, JSON.stringify(options.sessionState.metadata || {})]);
        }

        const previousResult = await client.query(`
            SELECT sequence, event_hash
            FROM ${schema}.audit_events
            WHERE session_id = $1
            ORDER BY sequence DESC
            LIMIT 1
        `, [sessionId]);
        let sequence = previousResult.rows[0] ? Number(previousResult.rows[0].sequence) : 0;
        let previousHash = previousResult.rows[0]?.event_hash || null;
        const inserted = [];

        for (const raw of events) {
            sequence += 1;
            const createdAt = canonicalIso(raw.createdAt || new Date());
            const content = raw.content == null ? null : String(raw.content);
            let storedContent = content;
            let blobRef = raw.blobRef || null;
            if (!blobRef && content != null && (
                raw.forceBlob === true || Buffer.byteLength(content, 'utf8') >= LARGE_CONTENT_BYTES
            )) {
                blobRef = sha256(content);
                await client.query(`
                    INSERT INTO ${schema}.audit_blobs (
                        hash, content, byte_length, created_at
                    ) VALUES ($1, $2, $3, $4)
                    ON CONFLICT (hash) DO NOTHING
                `, [blobRef, content, Buffer.byteLength(content, 'utf8'), createdAt]);
                storedContent = null;
            }
            const record = {
                id: raw.id || globalThis.crypto.randomUUID(),
                sessionId,
                sequence,
                traceId: raw.traceId || null,
                spanId: raw.spanId || null,
                parentSpanId: raw.parentSpanId || null,
                eventType: String(raw.eventType || 'runtime.event'),
                actor: raw.actor || null,
                content,
                payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
                blobRef,
                tokenCount: Number.isInteger(raw.tokenCount) ? raw.tokenCount : null,
                previousHash,
                createdAt,
            };
            record.eventHash = eventHash(record);
            await client.query(`
                INSERT INTO ${schema}.audit_events (
                    id, session_id, sequence, trace_id, span_id, parent_span_id,
                    event_type, actor, content, payload, blob_ref, token_count,
                    previous_hash, event_hash, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
                    $11, $12, $13, $14, $15
                )
            `, [
                record.id, sessionId, sequence, record.traceId, record.spanId,
                record.parentSpanId, record.eventType, record.actor, storedContent,
                JSON.stringify(record.payload), record.blobRef, record.tokenCount,
                previousHash, record.eventHash, createdAt,
            ]);
            if (raw.indexable !== false) {
                await client.query(`
                    INSERT INTO ${schema}.audit_index_queue (
                        event_id, status, attempts, created_at, updated_at
                    ) VALUES ($1, 'pending', 0, $2, $2)
                    ON CONFLICT (event_id) DO NOTHING
                `, [record.id, createdAt]);
            }
            inserted.push(record);
            previousHash = record.eventHash;
        }

        if (options.checkpoint !== undefined) {
            await client.query(`
                INSERT INTO ${schema}.context_checkpoints (
                    session_id, last_sequence, state, updated_at
                ) VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (session_id) DO UPDATE SET
                    last_sequence = excluded.last_sequence,
                    state = excluded.state,
                    updated_at = excluded.updated_at
            `, [sessionId, sequence, JSON.stringify(options.checkpoint || {}), new Date().toISOString()]);
        }
        return inserted;
    };

    if (options.client) {
        const { sql } = await ensureRuntimeDatabase();
        return operation(options.client, { sql });
    }
    return withRuntimeTransaction(operation);
}

async function readEvents(options = {}) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const conditions = [];
    const args = [];
    const add = (value, expression) => {
        args.push(value);
        conditions.push(expression.replace('?', `$${args.length}`));
    };
    if (options.sessionId) add(options.sessionId, 'e.session_id = ?');
    if (options.traceId) add(options.traceId, 'e.trace_id = ?');
    if (Number.isInteger(options.fromSequence)) add(options.fromSequence, 'e.sequence >= ?');
    if (Number.isInteger(options.toSequence)) add(options.toSequence, 'e.sequence <= ?');
    if (Number.isInteger(options.afterSequence)) add(options.afterSequence, 'e.sequence > ?');
    if (Array.isArray(options.eventTypes) && options.eventTypes.length > 0) {
        add(options.eventTypes, 'e.event_type = ANY(?::text[])');
    }
    const limit = Math.min(Math.max(Number(options.limit) || 10000, 1), 100000);
    args.push(limit);
    const result = await pool.query(`
        SELECT e.*, b.content AS blob_content
        FROM ${schema}.audit_events e
        LEFT JOIN ${schema}.audit_blobs b ON b.hash = e.blob_ref
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY e.session_id, e.sequence
        LIMIT $${args.length}
    `, args);
    return result.rows.map(row => mapEvent(row, row.blob_content));
}

async function eventSessionIds(options = {}) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    if (options.sessionId) return [options.sessionId];
    if (options.traceId) {
        const result = await pool.query(`
            SELECT DISTINCT session_id
            FROM ${schema}.audit_events
            WHERE trace_id = $1
            ORDER BY session_id
        `, [options.traceId]);
        return result.rows.map(row => row.session_id);
    }
    const result = await pool.query(`
        SELECT DISTINCT session_id
        FROM ${schema}.audit_events
        ORDER BY session_id
    `);
    return result.rows.map(row => row.session_id);
}

async function readAllEvents(options = {}) {
    const sessionIds = await eventSessionIds(options);
    const all = [];
    const pageSize = Math.min(Math.max(Number(options.pageSize) || 5000, 1), 10000);
    for (const sessionId of sessionIds) {
        let afterSequence = Number.isInteger(options.fromSequence)
            ? options.fromSequence - 1
            : 0;
        while (true) {
            const page = await readEvents({
                ...options,
                sessionId,
                fromSequence: undefined,
                afterSequence,
                limit: pageSize,
            });
            all.push(...page);
            if (page.length < pageSize) break;
            afterSequence = page[page.length - 1].sequence;
            if (Number.isInteger(options.toSequence) && afterSequence >= options.toSequence) break;
        }
    }
    return all.sort((left, right) => (
        left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence
    ));
}

async function readCheckpoint(sessionId) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const result = await pool.query(`
        SELECT last_sequence, state, updated_at
        FROM ${schema}.context_checkpoints
        WHERE session_id = $1
    `, [sessionId]);
    if (!result.rows[0]) return null;
    return {
        lastSequence: Number(result.rows[0].last_sequence),
        state: parseJson(result.rows[0].state, {}),
        updatedAt: toIso(result.rows[0].updated_at),
    };
}

async function verifySession(sessionId) {
    const events = await readAllEvents({ sessionId });
    let previousHash = null;
    const failures = [];
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.sequence !== index + 1) failures.push(`sequence:${event.sequence}`);
        if (event.previousHash !== previousHash) failures.push(`previousHash:${event.sequence}`);
        if (eventHash(event) !== event.eventHash) failures.push(`eventHash:${event.sequence}`);
        previousHash = event.eventHash;
    }
    return { ok: failures.length === 0, sessionId, eventCount: events.length, failures };
}

async function claimIndexEvents(options = {}) {
    const sessionIds = Array.isArray(options.sessionIds) ? options.sessionIds.filter(Boolean) : [];
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
    return withRuntimeTransaction(async (client, { sql: schema }) => {
        const args = [];
        let sessionFilter = '';
        if (sessionIds.length > 0) {
            args.push(sessionIds);
            sessionFilter = `AND e.session_id = ANY($${args.length}::text[])`;
        }
        args.push(limit);
        const picked = await client.query(`
            SELECT q.event_id
            FROM ${schema}.audit_index_queue q
            JOIN ${schema}.audit_events e ON e.id = q.event_id
            WHERE (
                q.status = 'pending'
                OR (q.status = 'failed' AND q.attempts < 5)
                OR (q.status = 'processing' AND q.updated_at < now() - interval '5 minutes')
            )
            ${sessionFilter}
            ORDER BY q.created_at
            FOR UPDATE OF q SKIP LOCKED
            LIMIT $${args.length}
        `, args);
        const ids = picked.rows.map(row => row.event_id);
        if (ids.length === 0) return [];
        await client.query(`
            UPDATE ${schema}.audit_index_queue
            SET status = 'processing', attempts = attempts + 1, last_error = NULL, updated_at = now()
            WHERE event_id = ANY($1::text[])
        `, [ids]);
        const result = await client.query(`
            SELECT e.*, b.content AS blob_content
            FROM ${schema}.audit_events e
            LEFT JOIN ${schema}.audit_blobs b ON b.hash = e.blob_ref
            WHERE e.id = ANY($1::text[])
            ORDER BY e.session_id, e.sequence
        `, [ids]);
        return result.rows.map(row => mapEvent(row, row.blob_content));
    });
}

async function completeIndexEvent(eventId, error = null) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    await pool.query(`
        UPDATE ${schema}.audit_index_queue
        SET status = $2, last_error = $3, updated_at = now()
        WHERE event_id = $1
    `, [eventId, error ? 'failed' : 'indexed', error ? String(error).slice(0, 4000) : null]);
}

async function listAuditSessions(limit = 1000) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const bounded = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
    const result = await pool.query(`
        SELECT session_id, MIN(created_at) AS started_at, MAX(created_at) AS updated_at,
               COUNT(*)::integer AS event_count
        FROM ${schema}.audit_events
        GROUP BY session_id
        ORDER BY updated_at DESC
        LIMIT $1
    `, [bounded]);
    return result.rows.map(row => ({
        sessionId: row.session_id,
        startedAt: toIso(row.started_at),
        updatedAt: toIso(row.updated_at),
        eventCount: Number(row.event_count),
    }));
}

async function resetIndexQueue(options = {}) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const sessionIds = Array.isArray(options.sessionIds) ? options.sessionIds.filter(Boolean) : [];
    const args = [];
    const filter = sessionIds.length > 0
        ? `WHERE event_id IN (
            SELECT id FROM ${schema}.audit_events WHERE session_id = ANY($1::text[])
        )`
        : '';
    if (sessionIds.length > 0) args.push(sessionIds);
    const result = await pool.query(`
        UPDATE ${schema}.audit_index_queue
        SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
        ${filter}
    `, args);
    return result.rowCount;
}

async function requeueIndexEvents(statuses = ['processing']) {
    const allowed = [...new Set((statuses || []).map(String))]
        .filter(status => ['processing', 'failed'].includes(status));
    if (allowed.length === 0) return 0;
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const result = await pool.query(`
        UPDATE ${schema}.audit_index_queue
        SET status = 'pending', last_error = NULL, updated_at = now()
        WHERE status = ANY($1::text[])
    `, [allowed]);
    return result.rowCount;
}

async function indexQueueStats() {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const result = await pool.query(`
        SELECT status, COUNT(*)::integer AS count
        FROM ${schema}.audit_index_queue
        GROUP BY status
    `);
    return Object.fromEntries(result.rows.map(row => [row.status, Number(row.count)]));
}

module.exports = {
    LARGE_CONTENT_BYTES,
    stableStringify,
    sha256,
    eventHash,
    appendEvents,
    readEvents,
    readAllEvents,
    readCheckpoint,
    verifySession,
    claimIndexEvents,
    completeIndexEvent,
    listAuditSessions,
    resetIndexQueue,
    requeueIndexEvents,
    indexQueueStats,
};
