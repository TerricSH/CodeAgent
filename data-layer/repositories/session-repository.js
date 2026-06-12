const { getDb, closeDb } = require('../sqlite/db');

function saveSession(sessionData) {
    const db = getDb();

    const insertSession = db.prepare(`
        INSERT OR REPLACE INTO sessions (id, start_time, end_time, metadata)
        VALUES (?, ?, ?, ?)
    `);
    const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
    const insertMessage = db.prepare(`
        INSERT INTO messages (session_id, role, content, timestamp, message_index)
        VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        insertSession.run(
            sessionData.id,
            sessionData.startTime,
            sessionData.endTime,
            sessionData.metadata ? JSON.stringify(sessionData.metadata) : null
        );
        deleteMessages.run(sessionData.id);

        sessionData.messages.forEach((msg, idx) => {
            insertMessage.run(sessionData.id, msg.role, msg.content, msg.timestamp, idx);
        });
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
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
        }));
}

function loadSession(id) {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!session) return null;

    const messages = db.prepare(
        'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY message_index'
    ).all(id);

    return {
        id: session.id,
        startTime: session.start_time,
        endTime: session.end_time,
        metadata: session.metadata ? JSON.parse(session.metadata) : null,
        messages,
    };
}

function close() {
    closeDb();
}

module.exports = { saveSession, listSessions, loadSession, close };
