const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();

const {
    ensureRuntimeDatabase,
    withRuntimeTransaction,
    closeRuntimeDatabase,
    runtimeDatabaseInfo,
} = require('../data-layer/postgres/runtime-db');

function parseArguments(argv) {
    const options = {
        source: path.resolve('.code', 'session.sqlite'),
        force: false,
        archive: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--force') options.force = true;
        else if (argument === '--archive') options.archive = true;
        else if (argument === '--source') {
            if (!argv[index + 1]) throw new Error('--source requires a file path');
            options.source = path.resolve(argv[index + 1]);
            index += 1;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return options;
}

function tableExists(database, name) {
    return Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name));
}

function rows(database, table) {
    return tableExists(database, table)
        ? database.prepare(`SELECT * FROM ${table}`).all()
        : [];
}

function json(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function jsonText(value, fallback = null) {
    const parsed = json(value, fallback);
    return parsed == null ? null : JSON.stringify(parsed);
}

function sourceDigest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function migrate(database, source, force) {
    const sessions = rows(database, 'sessions');
    const messages = rows(database, 'messages');
    const extensionStates = rows(database, 'extension_state');
    const memories = rows(database, 'memories');
    const migrationId = `sqlite-runtime-v1:${sourceDigest(source)}`;

    const result = await withRuntimeTransaction(async (client, { sql: schema }) => {
        const existing = await client.query(
            `SELECT details FROM ${schema}.runtime_migrations WHERE id = $1`,
            [migrationId]
        );
        if (existing.rows[0] && !force) {
            return { skipped: true, migrationId, ...(existing.rows[0].details || {}) };
        }

        for (const session of sessions) {
            await client.query(`
                INSERT INTO ${schema}.sessions (
                    id, user_id, start_time, end_time, metadata, summary, embedding
                ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
                ON CONFLICT (id) DO UPDATE SET
                    user_id = excluded.user_id,
                    start_time = excluded.start_time,
                    end_time = excluded.end_time,
                    metadata = excluded.metadata,
                    summary = excluded.summary,
                    embedding = excluded.embedding
            `, [
                session.id,
                session.user_id || null,
                session.start_time,
                session.end_time || null,
                jsonText(session.metadata),
                session.summary || null,
                session.embedding || null,
            ]);
        }

        for (const message of messages) {
            const createdAt = message.created_at || message.timestamp || new Date().toISOString();
            await client.query(`
                INSERT INTO ${schema}.messages (
                    session_id, role, content, timestamp, created_at, finished_at,
                    token_count, metadata, embedding, message_index, tool_call_id, tool_calls
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb
                )
                ON CONFLICT (session_id, message_index) DO UPDATE SET
                    role = excluded.role,
                    content = excluded.content,
                    timestamp = excluded.timestamp,
                    created_at = excluded.created_at,
                    finished_at = excluded.finished_at,
                    token_count = excluded.token_count,
                    metadata = excluded.metadata,
                    embedding = excluded.embedding,
                    tool_call_id = excluded.tool_call_id,
                    tool_calls = excluded.tool_calls
            `, [
                message.session_id,
                message.role,
                message.content,
                message.timestamp || createdAt,
                createdAt,
                message.finished_at || null,
                message.token_count == null ? null : Number(message.token_count),
                jsonText(message.metadata),
                message.embedding || null,
                Number(message.message_index),
                message.tool_call_id || null,
                jsonText(message.tool_calls),
            ]);
        }

        for (const state of extensionStates) {
            await client.query(`
                INSERT INTO ${schema}.extension_state (session_id, name, data, updated_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (session_id, name) DO UPDATE SET
                    data = excluded.data,
                    updated_at = excluded.updated_at
            `, [state.session_id, state.name, state.data, state.updated_at || new Date().toISOString()]);
        }

        for (const memory of memories) {
            await client.query(`
                INSERT INTO ${schema}.memories (
                    id, scope, owner_key, type, subject, content, importance, confidence,
                    status, source_session_id, source_message_indexes, supersedes, tags,
                    metadata, created_at, updated_at, last_accessed_at, access_count
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
                    $13::jsonb, $14::jsonb, $15, $16, $17, $18
                )
                ON CONFLICT (id) DO UPDATE SET
                    scope = excluded.scope,
                    owner_key = excluded.owner_key,
                    type = excluded.type,
                    subject = excluded.subject,
                    content = excluded.content,
                    importance = excluded.importance,
                    confidence = excluded.confidence,
                    status = excluded.status,
                    source_session_id = excluded.source_session_id,
                    source_message_indexes = excluded.source_message_indexes,
                    supersedes = excluded.supersedes,
                    tags = excluded.tags,
                    metadata = excluded.metadata,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    last_accessed_at = excluded.last_accessed_at,
                    access_count = excluded.access_count
            `, [
                memory.id,
                memory.scope,
                memory.owner_key,
                memory.type,
                memory.subject || null,
                memory.content,
                Number(memory.importance),
                Number(memory.confidence),
                memory.status,
                memory.source_session_id || null,
                jsonText(memory.source_message_indexes, []),
                memory.supersedes || null,
                jsonText(memory.tags, []),
                jsonText(memory.metadata, {}),
                memory.created_at,
                memory.updated_at,
                memory.last_accessed_at || null,
                Number(memory.access_count || 0),
            ]);
        }

        const details = {
            source: path.basename(source),
            sessions: sessions.length,
            messages: messages.length,
            extensionStates: extensionStates.length,
            memories: memories.length,
        };
        await client.query(`
            INSERT INTO ${schema}.runtime_migrations (id, applied_at, details)
            VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (id) DO UPDATE SET
                applied_at = excluded.applied_at,
                details = excluded.details
        `, [migrationId, new Date().toISOString(), JSON.stringify(details)]);
        return { skipped: false, migrationId, ...details };
    });
    return result;
}

function archiveDatabase(source) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDirectory = path.join(path.dirname(source), 'archive');
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const moved = [];
    for (const suffix of ['', '-wal', '-shm']) {
        const current = `${source}${suffix}`;
        if (!fs.existsSync(current)) continue;
        const destination = path.join(
            archiveDirectory,
            `${path.basename(source)}.${timestamp}${suffix}.bak`
        );
        fs.renameSync(current, destination);
        moved.push(destination);
    }
    return moved;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (!fs.existsSync(options.source)) {
        throw new Error(`SQLite source does not exist: ${options.source}`);
    }
    await ensureRuntimeDatabase();
    const database = new DatabaseSync(options.source, { readOnly: true });
    let result;
    try {
        result = await migrate(database, options.source, options.force);
    } finally {
        database.close();
    }
    const archived = options.archive && !result.skipped ? archiveDatabase(options.source) : [];
    console.log(JSON.stringify({
        backend: runtimeDatabaseInfo(),
        result,
        archived,
    }, null, 2));
}

main()
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(() => closeRuntimeDatabase().catch(() => {}));
