const test = require('node:test');
const assert = require('node:assert/strict');

const connectionString = process.env.RUNTIME_TEST_POSTGRES_URL;

test('PostgreSQL runtime persists sessions, extension state, and memory', {
    skip: !connectionString,
}, async (t) => {
    const schema = `codeagent_test_${process.pid}_${Date.now()}`;
    process.env.CODEAGENT_POSTGRES_URL = connectionString;
    process.env.CODEAGENT_POSTGRES_SCHEMA = schema;

    const runtimeDb = require('../data-layer/postgres/runtime-db');
    const Session = require('../session');
    const extensionState = require('../data-layer/repositories/extension-state-repository');
    const { MemoryRepository } = require('../plugins/memory/repository');
    const SessionRuntime = require('../runtime/session-runtime');

    await runtimeDb.ensureRuntimeDatabase();
    t.after(async () => {
        const pool = runtimeDb.getRuntimePool();
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await runtimeDb.closeRuntimeDatabase();
    });

    const session = new Session({
        id: `runtime-postgres-${Date.now()}`,
        metadata: { projectId: 'postgres-test' },
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
        ownerKey: 'postgres-test',
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
        [{ scope: 'project', ownerKey: 'postgres-test' }],
        { query: 'PostgreSQL' }
    );
    assert.equal(search[0].id, memoryId);
    assert.equal(await memory.forget(
        memoryId,
        [{ scope: 'project', ownerKey: 'postgres-test' }]
    ), true);

    const runtime = await new SessionRuntime({ workspaceRoot: process.cwd() }).start();
    runtime.context.addUser('full runtime persistence');
    await runtime.persist({ force: true });
    const runtimeSession = await Session.load(runtime.session.id);
    assert.equal(runtimeSession.messages[0].content, 'full runtime persistence');
    assert.ok(await extensionState.readState(runtime.session.id, 'memory'));
    await runtime.dispose('integration-test');
});
