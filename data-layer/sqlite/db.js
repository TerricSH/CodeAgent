const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', '..', '.code');
const DB_PATH = process.env.SESSION_DB_PATH || path.join(DB_DIR, 'session.sqlite');

let db = null;

function getDb() {
    if (db) return db;

    const dbParentDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbParentDir)) {
        fs.mkdirSync(dbParentDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    initSchema(db);
    return db;
}

function tableExists(connection, tableName) {
    const row = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);
    return Boolean(row);
}

function getTableColumns(connection, tableName) {
    return connection.prepare(`PRAGMA table_info(${tableName})`).all();
}

function ensureMessagesSchema(connection) {
    const createMessagesTableSql = `
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT,
            timestamp TEXT NOT NULL,
            created_at TEXT,
            finished_at TEXT,
            token_count INTEGER,
            metadata TEXT,
            embedding BLOB,
            message_index INTEGER NOT NULL,
            tool_call_id TEXT,
            tool_calls TEXT
        );
    `;

    if (!tableExists(connection, 'messages')) {
        connection.exec(createMessagesTableSql);
        connection.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);');
        return;
    }

    const columns = getTableColumns(connection, 'messages');
    const columnMap = new Map(columns.map((col) => [col.name, col]));
    const hasToolCallId = columnMap.has('tool_call_id');
    const hasToolCalls = columnMap.has('tool_calls');
    const hasCreatedAt = columnMap.has('created_at');
    const hasFinishedAt = columnMap.has('finished_at');
    const contentColumn = columnMap.get('content');
    const contentIsNotNull = contentColumn ? contentColumn.notnull === 1 : false;

    if (hasToolCallId && hasToolCalls && hasCreatedAt && hasFinishedAt && !contentIsNotNull) {
        connection.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);');
        return;
    }

    connection.exec('BEGIN');
    try {
        const createdAtExpr = hasCreatedAt ? 'COALESCE(created_at, timestamp)' : 'timestamp';
        const finishedAtExpr = hasFinishedAt ? 'finished_at' : 'NULL';

        connection.exec('DROP TABLE IF EXISTS messages_v2;');
        connection.exec(createMessagesTableSql.replace('messages', 'messages_v2'));

        connection.exec(`
            INSERT INTO messages_v2 (
                id, session_id, role, content, timestamp, created_at, finished_at, token_count, metadata, embedding, message_index
            )
            SELECT
                id,
                session_id,
                role,
                content,
                timestamp,
                ${createdAtExpr},
                ${finishedAtExpr},
                token_count,
                metadata,
                embedding,
                message_index
            FROM messages
            ORDER BY id;
        `);

        connection.exec('DROP TABLE messages;');
        connection.exec('ALTER TABLE messages_v2 RENAME TO messages;');
        connection.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);');
        connection.exec('COMMIT');
    } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
    }
}

function initSchema(connection) {
    connection.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            start_time TEXT NOT NULL,
            end_time TEXT,
            metadata TEXT,
            summary TEXT,
            embedding BLOB
        );

        CREATE TABLE IF NOT EXISTS extension_state (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            data TEXT,
            updated_at TEXT,
            PRIMARY KEY (session_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    `);

    ensureMessagesSchema(connection);
}

function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = { getDb, closeDb, DB_PATH };
