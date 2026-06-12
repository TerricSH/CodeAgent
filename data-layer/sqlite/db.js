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

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            token_count INTEGER,
            metadata TEXT,
            embedding BLOB,
            message_index INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    `);
}

function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = { getDb, closeDb, DB_PATH };
