const {
    ensureRuntimeDatabase,
    withRuntimeTransaction,
    closeRuntimeDatabase,
} = require('../postgres/runtime-db');

function serialize(value) {
    return value == null ? null : JSON.stringify(value);
}

function normalizeJson(value) {
    if (value == null || typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
}

function toIso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function mapSession(row) {
    return {
        id: row.id,
        startTime: toIso(row.start_time),
        endTime: toIso(row.end_time),
        metadata: normalizeJson(row.metadata),
    };
}

function mapMessage(row) {
    return {
        role: row.role,
        content: row.content,
        timestamp: toIso(row.timestamp),
        created_at: toIso(row.created_at),
        finished_at: toIso(row.finished_at),
        tool_call_id: row.tool_call_id,
        tool_calls: normalizeJson(row.tool_calls),
        metadata: normalizeJson(row.metadata),
        ...(row.message_index == null ? {} : { message_index: Number(row.message_index) }),
    };
}

async function saveSession(sessionData) {
    return withRuntimeTransaction(async (client, { sql: schema }) => {
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`codeagent-runtime-session:${sessionData.id}`]
        );
        await client.query(`
            INSERT INTO ${schema}.sessions (id, start_time, end_time, metadata)
            VALUES ($1, $2, $3, $4::jsonb)
            ON CONFLICT (id) DO UPDATE SET
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                metadata = excluded.metadata
        `, [
            sessionData.id,
            sessionData.startTime,
            sessionData.endTime,
            serialize(sessionData.metadata),
        ]);

        if (sessionData.persistMessages !== false) {
            const fromMessageIndex = Number.isInteger(sessionData.fromMessageIndex)
                ? Math.min(Math.max(sessionData.fromMessageIndex, 0), sessionData.messages.length)
                : 0;
            for (let index = fromMessageIndex; index < sessionData.messages.length; index += 1) {
                const message = sessionData.messages[index];
                const createdAt = message.created_at || message.timestamp || new Date().toISOString();
                await client.query(`
                    INSERT INTO ${schema}.messages (
                        session_id, role, content, timestamp, created_at, finished_at,
                        message_index, tool_call_id, tool_calls, metadata
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
                    ON CONFLICT (session_id, message_index) DO UPDATE SET
                        role = excluded.role,
                        content = excluded.content,
                        timestamp = excluded.timestamp,
                        created_at = excluded.created_at,
                        finished_at = excluded.finished_at,
                        tool_call_id = excluded.tool_call_id,
                        tool_calls = excluded.tool_calls,
                        metadata = excluded.metadata
                `, [
                    sessionData.id,
                    message.role,
                    message.content == null ? null : String(message.content),
                    message.timestamp || createdAt,
                    createdAt,
                    message.finished_at || null,
                    index,
                    message.tool_call_id || null,
                    serialize(message.tool_calls),
                    serialize(message.metadata),
                ]);
            }

            await client.query(
                `DELETE FROM ${schema}.messages WHERE session_id = $1 AND message_index >= $2`,
                [sessionData.id, sessionData.messages.length]
            );
        }

        if (typeof sessionData.persist === 'function') {
            await sessionData.persist(client);
        }
        return sessionData.id;
    });
}

async function listSessions() {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const result = await pool.query(`
        SELECT id, start_time, end_time, metadata
        FROM ${schema}.sessions
        ORDER BY start_time DESC
    `);
    return result.rows.map(mapSession);
}

async function loadSession(id) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const sessionResult = await pool.query(
        `SELECT * FROM ${schema}.sessions WHERE id = $1`,
        [id]
    );
    if (!sessionResult.rows[0]) return null;
    const messageResult = await pool.query(`
        SELECT role, content, timestamp, created_at, finished_at,
               tool_call_id, tool_calls, metadata
        FROM ${schema}.messages
        WHERE session_id = $1
        ORDER BY message_index
    `, [id]);
    return {
        ...mapSession(sessionResult.rows[0]),
        messages: messageResult.rows.map(mapMessage),
    };
}

async function loadSessionMetadata(id) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const result = await pool.query(
        `SELECT id, start_time, end_time, metadata FROM ${schema}.sessions WHERE id = $1`,
        [id]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
}

const MAX_QUERY_LIMIT = 200;

async function queryMessages(id, options = {}) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const select = options.select === 'meta' || options.select === 'preview' ? options.select : 'full';
    const order = options.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(Math.max(1, Number(options.limit) || 50), MAX_QUERY_LIMIT);
    const conditions = ['session_id = $1'];
    const args = [id];
    if (Number.isInteger(options.beforeIndex)) {
        args.push(options.beforeIndex);
        conditions.push(`message_index < $${args.length}`);
    }
    if (Number.isInteger(options.afterIndex)) {
        args.push(options.afterIndex);
        conditions.push(`message_index > $${args.length}`);
    }
    if (options.role) {
        args.push(options.role);
        conditions.push(`role = $${args.length}`);
    }
    args.push(limit);

    const columns = select === 'meta'
        ? 'role, message_index, created_at, finished_at'
        : select === 'preview'
            ? 'role, message_index, created_at, finished_at, left(content, 200) AS content'
            : 'role, content, timestamp, created_at, finished_at, tool_call_id, tool_calls, metadata, message_index';
    const result = await pool.query(`
        SELECT ${columns}
        FROM ${schema}.messages
        WHERE ${conditions.join(' AND ')}
        ORDER BY message_index ${order}
        LIMIT $${args.length}
    `, args);
    const items = result.rows.map((row) => {
        if (select === 'meta') {
            return {
                role: row.role,
                message_index: Number(row.message_index),
                created_at: toIso(row.created_at),
                finished_at: toIso(row.finished_at),
            };
        }
        return mapMessage(row);
    });
    return {
        items,
        cursor: items.length ? items[items.length - 1].message_index : null,
        count: items.length,
    };
}

async function countMessages(id) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const result = await pool.query(
        `SELECT COUNT(*)::integer AS count FROM ${schema}.messages WHERE session_id = $1`,
        [id]
    );
    return Number(result.rows[0].count);
}

const SORT_COLUMNS = {
    message_index: 'message_index',
    created_at: 'created_at',
    finished_at: 'finished_at',
};

async function getSessionMessages(id, options = {}) {
    const { pool, sql: schema } = await ensureRuntimeDatabase();
    const sortBy = SORT_COLUMNS[options.sortBy] || SORT_COLUMNS.message_index;
    const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
    const orderClause = sortBy === 'finished_at'
        ? `finished_at IS NULL, finished_at ${direction}, message_index ASC`
        : `${sortBy} ${direction}, message_index ASC`;
    const result = await pool.query(`
        SELECT role, content, timestamp, created_at, finished_at, tool_call_id,
               tool_calls, metadata, message_index
        FROM ${schema}.messages
        WHERE session_id = $1
        ORDER BY ${orderClause}
    `, [id]);
    return result.rows.map(mapMessage);
}

module.exports = {
    saveSession,
    listSessions,
    loadSession,
    loadSessionMetadata,
    getSessionMessages,
    queryMessages,
    countMessages,
    close: closeRuntimeDatabase,
};
