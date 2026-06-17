const { getDb } = require('../sqlite/db');

// 扩展状态仓储：对扩展（插件）内容无知，只按 (session_id, name) 做行级隔离存取。
// data 字段存放扩展自己序列化的“版本信封”字符串（{ name, version, data }）。
// 本仓储永不 JSON.parse 该内容，解释权完全归扩展自身。
function readState(sessionId, name) {
    const row = getDb()
        .prepare('SELECT data FROM extension_state WHERE session_id = ? AND name = ?')
        .get(sessionId, name);
    return row ? row.data : null;
}

function writeState(sessionId, name, data) {
    getDb()
        .prepare(`
            INSERT INTO extension_state (session_id, name, data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, name)
            DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
        `)
        .run(sessionId, name, data, new Date().toISOString());
}

// 注入给单个扩展的作用域 store：已绑定 name，只能读写自己的行。
// read/write 走共享数据库连接，因此可被宿主事务包裹，保证原子持久化。
function createScopedStore(name) {
    return {
        read: (sessionId) => readState(sessionId, name),
        write: (sessionId, data) => writeState(sessionId, name, data),
    };
}

module.exports = { readState, writeState, createScopedStore };
