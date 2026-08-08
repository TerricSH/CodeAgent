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

        CREATE TABLE IF NOT EXISTS ${schema}.audit_blobs (
            hash TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            mime_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
            byte_length BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${schema}.audit_events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
            sequence BIGINT NOT NULL,
            trace_id TEXT,
            span_id TEXT,
            parent_span_id TEXT,
            event_type TEXT NOT NULL,
            actor TEXT,
            content TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            blob_ref TEXT REFERENCES ${schema}.audit_blobs(hash),
            token_count INTEGER,
            previous_hash TEXT,
            event_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            UNIQUE (session_id, sequence)
        );

        CREATE TABLE IF NOT EXISTS ${schema}.context_checkpoints (
            session_id TEXT PRIMARY KEY REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
            last_sequence BIGINT NOT NULL DEFAULT 0,
            state JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${schema}.audit_index_queue (
            event_id TEXT PRIMARY KEY REFERENCES ${schema}.audit_events(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_sessions_user_id
            ON ${schema}.sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_runtime_messages_session_index
            ON ${schema}.messages(session_id, message_index);
        CREATE INDEX IF NOT EXISTS idx_runtime_memories_owner_status
            ON ${schema}.memories(scope, owner_key, status);
        CREATE INDEX IF NOT EXISTS idx_runtime_memories_subject
            ON ${schema}.memories(scope, owner_key, subject);
        CREATE INDEX IF NOT EXISTS idx_runtime_audit_session_sequence
            ON ${schema}.audit_events(session_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_runtime_audit_trace_sequence
            ON ${schema}.audit_events(trace_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_runtime_audit_parent_span
            ON ${schema}.audit_events(parent_span_id);
        CREATE INDEX IF NOT EXISTS idx_runtime_audit_event_type
            ON ${schema}.audit_events(event_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_runtime_audit_queue_status
            ON ${schema}.audit_index_queue(status, created_at);
    `);

    await client.query(`
        CREATE OR REPLACE FUNCTION ${schema}.reject_audit_event_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_events are immutable';
        END;
        $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS audit_events_immutable ON ${schema}.audit_events`);
    await client.query(`
        CREATE TRIGGER audit_events_immutable
        BEFORE UPDATE OR DELETE ON ${schema}.audit_events
        FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_audit_event_mutation()
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
