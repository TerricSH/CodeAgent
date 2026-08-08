const { Pool } = require('pg');

const DEFAULT_SCHEMA = 'codeagent_runtime';
let pool = null;
let ready = null;
let activeConfig = null;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateSchema(value) {
    const schema = String(value || DEFAULT_SCHEMA);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) {
        throw new Error('Runtime PostgreSQL schema must be a safe identifier up to 63 characters');
    }
    return schema;
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function loadRuntimeDatabaseConfig(overrides = {}) {
    return {
        connectionString: overrides.connectionString
            || process.env.CODEAGENT_POSTGRES_URL
            || process.env.DATABASE_URL
            || process.env.RAG_POSTGRES_URL
            || null,
        schema: validateSchema(
            overrides.schema || process.env.CODEAGENT_POSTGRES_SCHEMA || DEFAULT_SCHEMA
        ),
        maxConnections: positiveInteger(
            overrides.maxConnections || process.env.CODEAGENT_POSTGRES_MAX_CONNECTIONS,
            10
        ),
        connectionTimeoutMillis: positiveInteger(
            overrides.connectionTimeoutMillis || process.env.CODEAGENT_POSTGRES_CONNECTION_TIMEOUT_MS,
            5000
        ),
    };
}

function getRuntimePool() {
    if (pool) return pool;
    activeConfig = loadRuntimeDatabaseConfig();
    if (!activeConfig.connectionString) {
        throw new Error(
            'Runtime PostgreSQL is not configured: set CODEAGENT_POSTGRES_URL, DATABASE_URL, or RAG_POSTGRES_URL'
        );
    }
    pool = new Pool({
        connectionString: activeConfig.connectionString,
        max: activeConfig.maxConnections,
        connectionTimeoutMillis: activeConfig.connectionTimeoutMillis,
    });
    return pool;
}

function getRuntimeSchema() {
    if (!activeConfig) activeConfig = loadRuntimeDatabaseConfig();
    return {
        name: activeConfig.schema,
        sql: quoteIdentifier(activeConfig.schema),
    };
}

async function initialize(client) {
    const { sql: schema } = getRuntimeSchema();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            start_time TIMESTAMPTZ NOT NULL,
            end_time TIMESTAMPTZ,
            metadata JSONB,
            summary TEXT,
            embedding BYTEA
        );

        CREATE TABLE IF NOT EXISTS ${schema}.messages (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT,
            timestamp TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            token_count INTEGER,
            metadata JSONB,
            embedding BYTEA,
            message_index INTEGER NOT NULL,
            tool_call_id TEXT,
            tool_calls JSONB,
            UNIQUE (session_id, message_index)
        );

        CREATE TABLE IF NOT EXISTS ${schema}.extension_state (
            session_id TEXT NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            data TEXT,
            updated_at TIMESTAMPTZ,
            PRIMARY KEY (session_id, name)
        );

        CREATE TABLE IF NOT EXISTS ${schema}.memories (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            owner_key TEXT NOT NULL,
            type TEXT NOT NULL,
            subject TEXT,
            content TEXT NOT NULL,
            importance REAL NOT NULL DEFAULT 0.5,
            confidence REAL NOT NULL DEFAULT 1.0,
            status TEXT NOT NULL DEFAULT 'active',
            source_session_id TEXT,
            source_message_indexes JSONB NOT NULL DEFAULT '[]'::jsonb,
            supersedes TEXT,
            tags JSONB NOT NULL DEFAULT '[]'::jsonb,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            last_accessed_at TIMESTAMPTZ,
            access_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ${schema}.runtime_migrations (
            id TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL,
            details JSONB NOT NULL DEFAULT '{}'::jsonb
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_sessions_user_id
            ON ${schema}.sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_runtime_messages_session_index
            ON ${schema}.messages(session_id, message_index);
        CREATE INDEX IF NOT EXISTS idx_runtime_memories_owner_status
            ON ${schema}.memories(scope, owner_key, status);
        CREATE INDEX IF NOT EXISTS idx_runtime_memories_subject
            ON ${schema}.memories(scope, owner_key, subject);
    `);
}

async function ensureRuntimeDatabase() {
    if (!ready) {
        ready = (async () => {
            const client = await getRuntimePool().connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    'SELECT pg_advisory_xact_lock(hashtext($1))',
                    [`codeagent-runtime-schema:${getRuntimeSchema().name}`]
                );
                await initialize(client);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        })().catch((error) => {
            ready = null;
            throw error;
        });
    }
    await ready;
    return { pool: getRuntimePool(), ...getRuntimeSchema() };
}

async function withRuntimeTransaction(operation) {
    const runtime = await ensureRuntimeDatabase();
    const client = await runtime.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await operation(client, runtime);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function closeRuntimeDatabase() {
    const current = pool;
    pool = null;
    ready = null;
    activeConfig = null;
    if (current) await current.end();
}

function runtimeDatabaseInfo() {
    const config = activeConfig || loadRuntimeDatabaseConfig();
    return {
        backend: 'postgresql',
        schema: config.schema,
        configured: Boolean(config.connectionString),
    };
}

module.exports = {
    DEFAULT_SCHEMA,
    validateSchema,
    quoteIdentifier,
    loadRuntimeDatabaseConfig,
    getRuntimePool,
    getRuntimeSchema,
    ensureRuntimeDatabase,
    withRuntimeTransaction,
    closeRuntimeDatabase,
    runtimeDatabaseInfo,
};
