const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../context');
const { estimateRequestTokens } = require('../context/tokens');
const { defaultOutputReserve } = require('../model-providers/interfaces/base-interface');
const { hasDanglingTool } = require('../context/transport');
const activateSkill = require('../tools/activate-skill');
const { AuditTrajectorySource } = require('../trajectory-extraction');
const {
    legacyEvents,
    validateLegacySession,
} = require('../scripts/migrate-messages-to-audit');
const AuditWriter = require('../runtime/audit-writer');
const runAgentLoop = require('../agent-runner');
const AuditRenderer = require('../runtime/audit-renderer');

test('Context derives capacity from tokens and supports more than five Skill nodes', () => {
    const context = new Context('base', { maxContextTokens: 20000, safetyMargin: 0 });
    const traceId = 'trace-six-skills';
    context.startTask(traceId);
    for (let index = 0; index < 6; index += 1) {
        context.load({
            role: 'system',
            content: `Skill ${index}: ${'procedure '.repeat(20)}`,
            kind: 'skill',
            sourceRef: `skill:test-${index}`,
        });
    }
    context.addUser('Use all six skills together.', { beginTurn: true });
    const prepared = context.prepareRequest({
        tools: [],
        modelProfile: {
            maxContextTokens: 20000,
            maxOutputTokens: 1000,
            countTokens: estimateRequestTokens,
        },
    });
    assert.equal(prepared.usage.byType.skill > 0, true);
    assert.equal(context.cache.entries.filter(entry => entry.kind === 'skill' && entry.resident).length, 6);
    assert.ok(prepared.usage.maxResidentCount >= 7);
});

test('Context evicts whole atomic Tool spans under pressure', () => {
    const context = new Context('base', { maxContextTokens: 220, safetyMargin: 0 });
    context.startTask('trace-atomic');
    context.addUser('old '.repeat(200));
    context.addAssistant('answer '.repeat(180));
    context.addAssistantToolCalls([{ id: 'call-1', name: 'read_file', arguments: { path: 'a.js' } }]);
    context.addToolResult('call-1', 'result '.repeat(120));
    context.addUser('current request');
    const prepared = context.prepareRequest({
        tools: [],
        modelProfile: {
            maxContextTokens: 220,
            maxOutputTokens: 100,
            countTokens: estimateRequestTokens,
        },
    });
    assert.equal(hasDanglingTool(prepared.messages), false);
    assert.ok(prepared.usage.coldNodes > 0);
    assert.ok(prepared.usage.reductionReasons.length > 0);
});

test('Tool spans stay causal and are delivered exactly before the final assistant reply', () => {
    const context = new Context('base', { maxContextTokens: 4000, safetyMargin: 0 });
    context.addUser('inspect the file');
    context.addAssistantToolCalls([{ id: 'call-order', name: 'read_file', arguments: { path: 'a.js' } }]);
    context.addToolResult('call-order', 'file contents');

    const first = context.prepareRequest({
        tools: [],
        modelProfile: { maxContextTokens: 4000, maxOutputTokens: 500, countTokens: estimateRequestTokens },
    });
    assert.deepEqual(first.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);

    context.addAssistant('The file is valid.');
    const second = context.prepareRequest({
        tools: [],
        modelProfile: { maxContextTokens: 4000, maxOutputTokens: 500, countTokens: estimateRequestTokens },
    });
    assert.deepEqual(second.messages.map(message => message.role), [
        'system', 'user', 'assistant', 'tool', 'assistant',
    ]);
    const dialogueNodes = context.cache.entries.filter(entry =>
        entry.messages.some(message => message.content === 'inspect the file')
        || entry.messages.some(message => message.content === 'The file is valid.')
    );
    assert.equal(dialogueNodes.length, 2);
    assert.equal(dialogueNodes[0].atomicGroupId, dialogueNodes[1].atomicGroupId);
});

test('a Tool-mediated user/reply pair is evicted as one atomic group', () => {
    const context = new Context('base', { maxContextTokens: 260, safetyMargin: 0 });
    context.addUser('old user request '.repeat(30));
    context.addAssistantToolCalls([{ id: 'call-pair', name: 'read_file', arguments: { path: 'a.js' } }]);
    context.addToolResult('call-pair', 'small result');
    context.prepareRequest({
        tools: [],
        modelProfile: { maxContextTokens: 2000, maxOutputTokens: 100, countTokens: estimateRequestTokens },
    });
    context.addAssistant('old final answer '.repeat(30));
    const pairGroupId = context.cache.entries.find(entry =>
        entry.messages.some(message => String(message.content).includes('old user request'))
    ).atomicGroupId;
    context.addUser('new request');
    context.prepareRequest({
        tools: [],
        modelProfile: { maxContextTokens: 260, maxOutputTokens: 100, countTokens: estimateRequestTokens },
    });
    const pair = context.cache.entries.filter(entry => entry.atomicGroupId === pairGroupId);
    assert.equal(pair.length, 2);
    assert.deepEqual([...new Set(pair.map(entry => entry.resident))], [false]);
});

test('oversized completed Tool results use an Audit-backed source representation', () => {
    const context = new Context('base', {
        sessionId: 'session-large',
        maxContextTokens: 320,
        safetyMargin: 0,
    });
    context.startTask('trace-large');
    context.addUser('summarize the result');
    context.addAssistantToolCalls([{ id: 'call-large', name: 'read_file', arguments: { path: 'large.log' } }]);
    context.addToolResult('call-large', 'payload '.repeat(2000));
    const prepared = context.prepareRequest({
        tools: [],
        modelProfile: { maxContextTokens: 320, maxOutputTokens: 100, countTokens: estimateRequestTokens },
    });
    const toolNode = context.cache.entries.find(entry => entry.kind === 'tool_exchange');
    assert.equal(toolNode.representation, 'source-only');
    assert.equal(hasDanglingTool(prepared.messages), false);
    assert.match(prepared.messages.at(-1).content, /audit:session-large:trace:trace-large/);
});

test('AuditWriter restores a failed batch ahead of later events for retry', async () => {
    const committed = [];
    let fail = true;
    const writer = new AuditWriter('session-retry', {
        batchSize: 100,
        repository: {
            appendEvents: async (_sessionId, events) => {
                if (fail) {
                    fail = false;
                    throw new Error('transient database failure');
                }
                committed.push(...events);
                return events;
            },
        },
    });
    writer.record({ eventType: 'task.started' });
    writer.record({ eventType: 'model.request' });
    await assert.rejects(writer.flush(), /transient database failure/);
    writer.record({ eventType: 'model.completed' });
    await writer.flush();
    assert.deepEqual(committed.map(event => event.eventType), [
        'task.started', 'model.request', 'model.completed',
    ]);
});

test('AuditWriter drops a rolled-back transactional event but keeps earlier buffered events', async () => {
    const committed = [];
    let fail = true;
    const repository = {
        appendEvents: async (_sessionId, events) => {
            if (fail) {
                fail = false;
                throw new Error('transaction rolled back');
            }
            committed.push(...events);
            return events;
        },
    };
    const writer = new AuditWriter('session-transaction', { batchSize: 100, repository });
    writer.record({ eventType: 'tool.started' });
    await assert.rejects(
        writer.appendTransactional(
            { eventType: 'memory.remembered' },
            {},
            { query: async () => {} }
        ),
        /transaction rolled back/
    );
    writer.record({ eventType: 'tool.failed' });
    await writer.flush();
    assert.deepEqual(committed.map(event => event.eventType), ['tool.started', 'tool.failed']);
});

test('default model output reserve follows the configured window formula', () => {
    assert.equal(defaultOutputReserve(100000), 5000);
    assert.equal(defaultOutputReserve(1048576), 32768);
    assert.equal(defaultOutputReserve(32000), 4096);
});

test('Skill activation uses independent cache nodes instead of a single system section', async () => {
    const context = new Context('base');
    await activateSkill.handler({ name: 'code-review' }, context);
    await activateSkill.handler({ name: 'systematic-debugging' }, context);
    const active = context.cache.entries.filter(entry => entry.kind === 'skill' && entry.resident);
    assert.equal(active.length, 2);
    assert.deepEqual(active.map(entry => entry.metadata.skillName).sort(), [
        'code-review', 'systematic-debugging',
    ]);
});

test('a Skill records skill.used only when it is actually sent to the model', () => {
    const events = [];
    const context = new Context('base', {
        maxContextTokens: 4000,
        safetyMargin: 0,
        auditWriter: { record: event => events.push(event) },
    });
    context.load({
        role: 'system',
        content: 'Use the review procedure.',
        kind: 'skill',
        sourceRef: 'skill:review',
        metadata: { skillName: 'review' },
    });
    assert.equal(events.some(event => event.eventType === 'skill.used'), false);
    context.addUser('Review this change.');
    context.prepareRequest({
        tools: [],
        modelProfile: {
            maxContextTokens: 4000,
            maxOutputTokens: 500,
            countTokens: estimateRequestTokens,
        },
    });
    const used = events.filter(event => event.eventType === 'skill.used');
    assert.equal(used.length, 1);
    assert.equal(used[0].actor, 'skill');
    assert.equal(used[0].payload.name, 'review');
});

test('AuditWriter records real Trace duration and pre-completion statistics', () => {
    const writer = new AuditWriter('session-stats', { batchSize: 100 });
    const traceId = writer.startTrace({ content: 'measure this task' });
    writer.record({ eventType: 'model.request', tokenCount: 17 });
    writer.finishTrace('completed', { outcome: 'ok' });
    const completed = writer.buffer.find(event => event.eventType === 'task.completed');
    assert.equal(completed.traceId, traceId);
    assert.equal(completed.payload.outcome, 'ok');
    assert.ok(completed.payload.durationMs >= 0);
    assert.equal(completed.payload.eventCountBeforeCompletion, 2);
    assert.equal(completed.payload.recordedTokenCount, 17);
});

test('Audit trajectory extraction reads a known Trace directly and never invents reward', async () => {
    const events = [
        { id: '1', sessionId: 's1', sequence: 1, traceId: 't1', spanId: 't1', parentSpanId: null, eventType: 'task.started', actor: 'user', content: 'task', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: '2', sessionId: 's1', sequence: 2, traceId: 't1', spanId: 'm1', parentSpanId: 't1', eventType: 'model.reasoning', actor: 'model', content: 'reason', payload: {}, createdAt: '2026-01-01T00:00:01.000Z' },
        { id: '3', sessionId: 's1', sequence: 3, traceId: 't1', spanId: 't1', parentSpanId: null, eventType: 'task.completed', actor: 'runtime', content: null, payload: {}, createdAt: '2026-01-01T00:00:02.000Z' },
    ];
    const calls = [];
    const source = new AuditTrajectorySource({
        auditRepository: {
            readEvents: async options => { calls.push(options); return events; },
            listAuditSessions: async () => [],
        },
        historyRag: { search: async () => { throw new Error('RAG must not run for known Trace'); } },
    });
    const result = await source.trace('t1', { includeReasoning: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].traceId, 't1');
    assert.equal(result.events.some(event => event.eventType === 'model.reasoning'), false);
    assert.equal(result.outcome.status, 'succeeded');
    assert.equal(result.outcome.reward, null);
});

test('legacy migration creates one legacy Trace without fabricating reasoning', () => {
    const events = legacyEvents({
        id: 'legacy-session',
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:01:00.000Z',
        messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
    });
    assert.deepEqual([...new Set(events.map(event => event.traceId))], ['legacy:legacy-session']);
    assert.equal(events.some(event => event.eventType === 'model.reasoning'), false);
    assert.equal(events.at(-1).payload.migrationValidation.ok, true);
});

test('legacy migration validation reports ordering, Tool pairing, and parent failures', () => {
    const validation = validateLegacySession({
        id: 'legacy-invalid',
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:02:00.000Z',
        metadata: { parentSessionId: 'missing-parent' },
        messages: [
            {
                role: 'assistant',
                content: null,
                created_at: '2026-01-01T00:01:00.000Z',
                tool_calls: [{ id: 'call-unresolved', function: { name: 'read_file' } }],
            },
            {
                role: 'tool',
                tool_call_id: 'call-orphan',
                content: 'result',
                created_at: '2026-01-01T00:00:30.000Z',
            },
        ],
    }, new Set(['legacy-invalid']));
    const codes = validation.failures.map(failure => failure.code);
    assert.equal(validation.ok, false);
    assert.ok(codes.includes('message-time-out-of-order'));
    assert.ok(codes.includes('orphan-tool-result'));
    assert.ok(codes.includes('missing-tool-result'));
    assert.ok(codes.includes('missing-parent-session'));
});

test('Agent Runner checkpoints assistant Tool content and paired results before the next model call', async () => {
    const context = new Context('base', { maxContextTokens: 4000, safetyMargin: 0 });
    const audit = {
        activeTraceId: 'trace-runner',
        events: [],
        record(event) { this.events.push(event); },
        async flush() {},
        finishTrace() { this.activeTraceId = null; },
    };
    context.startTask(audit.activeTraceId);
    context.addUser('inspect');
    let request = 0;
    let secondMessages = null;
    const client = {
        info: () => ({
            maxContextTokens: 4000,
            maxOutputTokens: 500,
            countTokens: estimateRequestTokens,
        }),
        async *chat(messages) {
            request += 1;
            if (request === 1) {
                yield { type: 'content', content: 'I will inspect it.' };
                yield {
                    type: 'tool_calls',
                    calls: [{ id: 'runner-call', name: 'read_file', arguments: { path: 'a.js' } }],
                };
                return;
            }
            secondMessages = messages;
            yield { type: 'content', content: 'Done.' };
        },
    };
    const toolDefinition = {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'read',
            parameters: { type: 'object', properties: {} },
        },
    };
    const toolRegistry = {
        definitions: [toolDefinition],
        has: name => name === 'read_file',
        execute: async () => 'file body',
    };
    const noop = () => {};
    const output = {
        thinking: { renderStart: noop, render: noop, renderEnd: noop },
        content: { renderStart: noop, render: noop, renderEnd: noop },
        tool: { renderCall: noop, renderResult: noop },
    };
    const reply = await runAgentLoop(context, output, {
        client,
        toolRegistry,
        tools: [toolDefinition],
        audit,
    });
    assert.equal(reply, 'Done.');
    assert.deepEqual(secondMessages.map(message => message.role), [
        'system', 'user', 'assistant', 'tool',
    ]);
    assert.equal(secondMessages[2].content, 'I will inspect it.');
    assert.equal(secondMessages[3].content, 'file body');
});

test('Markdown Audit rendering reports hash-chain validation without becoming a runtime source', async () => {
    const events = [{
        id: 'event-1',
        sessionId: 'session-render',
        sequence: 1,
        traceId: 'trace-render',
        spanId: 'trace-render',
        parentSpanId: null,
        eventType: 'task.started',
        actor: 'user',
        content: 'render me',
        payload: {},
        tokenCount: 2,
        previousHash: null,
        eventHash: 'hash-1',
        createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const renderer = new AuditRenderer({
        repository: {
            readAllEvents: async () => events,
            verifySession: async sessionId => ({
                ok: true,
                sessionId,
                eventCount: 1,
                failures: [],
            }),
        },
    });
    const result = await renderer.render({ sessionId: 'session-render' });
    assert.equal(result.valid, true);
    assert.match(result.markdown, /Hash-chain validation: \*\*VALID\*\*/);
    assert.match(result.markdown, /render me/);
});
