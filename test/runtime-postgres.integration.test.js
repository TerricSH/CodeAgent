const test = require('node:test');
const assert = require('node:assert/strict');

const connectionString = process.env.RUNTIME_TEST_POSTGRES_URL;

test('PostgreSQL runtime persists sessions, extension state, and memory', {
    skip: !connectionString,
}, async (t) => {
    const schema = `codeagent_test_${process.pid}_${Date.now()}`;
    const ragSchema = `${schema}_rag`;
    const projectKey = `postgres-test:${schema}`;
    process.env.CODEAGENT_POSTGRES_URL = connectionString;
    process.env.CODEAGENT_POSTGRES_SCHEMA = schema;
    process.env.RAG_POSTGRES_URL = connectionString;
    process.env.RAG_POSTGRES_SCHEMA = ragSchema;

    const runtimeDb = require('../data-layer/postgres/runtime-db');
    const Session = require('../session');
    const extensionState = require('../data-layer/repositories/extension-state-repository');
    const { MemoryRepository } = require('../plugins/memory/repository');
    const SessionRuntime = require('../runtime/session-runtime');
    const auditRepository = require('../data-layer/repositories/audit-repository');

    await runtimeDb.ensureRuntimeDatabase();
    t.after(async () => {
        const pool = runtimeDb.getRuntimePool();
        await pool.query(`DROP SCHEMA IF EXISTS "${ragSchema}" CASCADE`);
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await runtimeDb.closeRuntimeDatabase();
    });

    const session = new Session({
        id: `runtime-postgres-${Date.now()}`,
        metadata: { projectId: projectKey },
    });
    const sessionMessages = [
        { role: 'user', content: 'persist me', created_at: new Date().toISOString() },
        { role: 'assistant', content: 'persisted', created_at: new Date().toISOString() },
    ];
    await session.save({
        endTime: null,
        metadata: session.metadata,
        messages: sessionMessages,
        persist: client => extensionState.writeState(
            session.id,
            'fixture',
            JSON.stringify({ version: 1 }),
            { client }
        ),
    });

    const loaded = await Session.load(session.id);
    assert.equal(loaded.id, session.id);
    assert.deepEqual(loaded.metadata, session.metadata);
    assert.deepEqual(loaded.messages.map(message => message.content), ['persist me', 'persisted']);
    assert.equal(await Session.count(session.id), 2);
    assert.equal(
        await extensionState.readState(session.id, 'fixture'),
        JSON.stringify({ version: 1 })
    );
    sessionMessages.push({
        role: 'user',
        content: 'append only',
        created_at: new Date().toISOString(),
    });
    await session.save({ endTime: null, metadata: session.metadata, messages: sessionMessages });
    assert.equal(await Session.count(session.id), 3);

    const memory = new MemoryRepository();
    const memoryId = await memory.remember({
        scope: 'project',
        ownerKey: projectKey,
        type: 'semantic',
        subject: 'database',
        content: 'Runtime state uses PostgreSQL.',
        importance: 0.8,
        confidence: 1,
        sourceSessionId: session.id,
        sourceMessageIndexes: [0, 1],
        tags: ['postgresql'],
        metadata: { verified: true },
    });
    const search = await memory.searchMemories(
        [{ scope: 'project', ownerKey: projectKey }],
        { query: 'PostgreSQL' }
    );
    assert.equal(search[0].id, memoryId);
    assert.equal(await memory.forget(
        memoryId,
        [{ scope: 'project', ownerKey: projectKey }]
    ), true);

    const runtime = await new SessionRuntime({ workspaceRoot: process.cwd() }).start();
    runtime.context.addUser('full runtime persistence');
    const runtimeMemory = runtime.context.getExtension('memory');
    const runtimeMemoryId = await runtimeMemory.remember({
        scope: 'session',
        type: 'semantic',
        subject: 'audit-transaction',
        content: 'Memory and Audit commit in the same PostgreSQL transaction.',
    });
    await runtime.persist({ force: true });
    const runtimeSession = await Session.load(runtime.session.id);
    assert.equal(runtimeSession.messages.length, 0);
    const auditEvents = await auditRepository.readEvents({ sessionId: runtime.session.id });
    assert.ok(auditEvents.some(event =>
        event.eventType === 'dialogue.user' && event.content === 'full runtime persistence'
    ));
    assert.ok(auditEvents.some(event =>
        event.eventType === 'memory.remembered' && event.payload.memoryId === runtimeMemoryId
    ));
    assert.equal((await auditRepository.verifySession(runtime.session.id)).ok, true);
    await assert.rejects(
        runtimeDb.getRuntimePool().query(`
            UPDATE "${schema}".audit_events SET actor = 'mutated'
            WHERE session_id = $1
        `, [runtime.session.id]),
        /immutable/
    );
    assert.ok(await extensionState.readState(runtime.session.id, 'memory'));
    await runtime.dispose('integration-test');
});
