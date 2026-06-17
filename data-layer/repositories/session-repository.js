const { getDb, closeDb } = require('../sqlite/db');

function serialize(value) {
    return value == null ? null : JSON.stringify(value);
}

function parseJson(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function saveSession(sessionData) {
    const db = getDb();

    const insertSession = db.prepare(`
        INSERT OR REPLACE INTO sessions (id, start_time, end_time, metadata)
        VALUES (?, ?, ?, ?)
    `);
    const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
    const insertMessage = db.prepare(`
        INSERT INTO messages (session_id, role, content, timestamp, created_at, finished_at, message_index, tool_call_id, tool_calls, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        insertSession.run(
            sessionData.id,
            sessionData.startTime,
            sessionData.endTime,
            serialize(sessionData.metadata)
        );
        deleteMessages.run(sessionData.id);

        sessionData.messages.forEach((msg, idx) => {
            const createdAt = msg.created_at || msg.timestamp || new Date().toISOString();
            insertMessage.run(
                sessionData.id,
                msg.role,
                msg.content == null ? null : String(msg.content),
                msg.timestamp || createdAt,
                createdAt,
                msg.finished_at || null,
                idx,
                msg.tool_call_id || null,
                serialize(msg.tool_calls),
                serialize(msg.metadata)
            );
        });

        // 原子持久化：扩展状态在同一事务内落库，与消息一起提交或一起回滚，杜绝半存。
        if (typeof sessionData.persist === 'function') {
            sessionData.persist();
        }
    });

    transaction();
}

function listSessions() {
    const db = getDb();
    return db.prepare('SELECT id, start_time, end_time, metadata FROM sessions ORDER BY start_time DESC').all()
        .map((row) => ({
            id: row.id,
            startTime: row.start_time,
            endTime: row.end_time,
            metadata: parseJson(row.metadata),
        }));
}

function loadSession(id) {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!session) return null;

    const messages = db.prepare(
        'SELECT role, content, timestamp, created_at, finished_at, tool_call_id, tool_calls, metadata FROM messages WHERE session_id = ? ORDER BY message_index'
    ).all(id).map((row) => ({
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        created_at: row.created_at,
        finished_at: row.finished_at,
        tool_call_id: row.tool_call_id,
        tool_calls: parseJson(row.tool_calls),
        metadata: parseJson(row.metadata),
    }));

    return {
        id: session.id,
        startTime: session.start_time,
        endTime: session.end_time,
        metadata: parseJson(session.metadata),
        messages,
    };
}

function close() {
    closeDb();
}

const SORT_COLUMNS = {
    message_index: 'message_index',
    created_at: 'created_at',
    finished_at: 'finished_at',
};

function getSessionMessages(id, options = {}) {
    const db = getDb();
    const sortBy = SORT_COLUMNS[options.sortBy] || SORT_COLUMNS.message_index;
    const direction = options.direction === 'desc' ? 'DESC' : 'ASC';

    // finished_at can be NULL (non-tool messages); keep them last while preserving stable order.
    const orderClause = sortBy === 'finished_at'
        ? `finished_at IS NULL, finished_at ${direction}, message_index ASC`
        : `${sortBy} ${direction}, message_index ASC`;

    return db.prepare(
        `SELECT role, content, timestamp, created_at, finished_at, tool_call_id, tool_calls, metadata, message_index
         FROM messages WHERE session_id = ? ORDER BY ${orderClause}`
    ).all(id).map((row) => ({
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        created_at: row.created_at,
        finished_at: row.finished_at,
        tool_call_id: row.tool_call_id,
        tool_calls: parseJson(row.tool_calls),
        metadata: parseJson(row.metadata),
        message_index: row.message_index,
    }));
}

module.exports = { saveSession, listSessions, loadSession, getSessionMessages, close };
