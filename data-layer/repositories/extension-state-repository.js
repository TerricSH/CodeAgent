const { ensureRuntimeDatabase } = require('../postgres/runtime-db');

async function queryable(options = {}) {
    if (options.client) {
        const { sql } = await ensureRuntimeDatabase();
        return { connection: options.client, schema: sql };
    }
    const { pool, sql } = await ensureRuntimeDatabase();
    return { connection: pool, schema: sql };
}

async function readState(sessionId, name, options = {}) {
    const { connection, schema } = await queryable(options);
    const result = await connection.query(`
        SELECT data FROM ${schema}.extension_state
        WHERE session_id = $1 AND name = $2
    `, [sessionId, name]);
    return result.rows[0] ? result.rows[0].data : null;
}

async function writeState(sessionId, name, data, options = {}) {
    const { connection, schema } = await queryable(options);
    await connection.query(`
        INSERT INTO ${schema}.extension_state (session_id, name, data, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (session_id, name) DO UPDATE SET
            data = excluded.data,
            updated_at = excluded.updated_at
    `, [sessionId, name, data, new Date().toISOString()]);
}

function createScopedStore(name) {
    return {
        read: (sessionId, options) => readState(sessionId, name, options),
        write: (sessionId, data, options) => writeState(sessionId, name, data, options),
    };
}

module.exports = { readState, writeState, createScopedStore };
