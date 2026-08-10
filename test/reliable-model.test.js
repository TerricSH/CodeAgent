const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReliableModelCapability } = require('../runtime/reliable-model');
const { TrajectoryJournal, readJsonl } = require('../skill-refinement/trajectory-journal');

test('model transport retries never leak partial reasoning into the semantic trajectory', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root);
    let attempt = 0;
    const model = {
        info: () => ({ ref: 'local@test/model', model: 'model' }),
        async *chat() {
            attempt += 1;
            if (attempt === 1) {
                yield { type: 'thinking', content: 'discarded partial reasoning' };
                const error = new Error('socket connection reset');
                error.code = 'ECONNRESET';
                throw error;
            }
            yield { type: 'thinking', content: 'kept ' };
            yield { type: 'thinking', content: 'reasoning' };
            yield { type: 'content', content: 'final answer' };
        },
    };
    const reliable = createReliableModelCapability(model, {
        recorder: journal,
        maxAttempts: 2,
        retryDelayMs: 0,
        reasoningRequired: true,
    });

    const result = await reliable.completeDetailed([{ role: 'user', content: 'task' }], {
        purpose: 'execution',
    });
    const cleaned = journal.clean();
    const transport = readJsonl(journal.transportPath);
    const raw = readJsonl(journal.rawPath);

    assert.equal(result.reasoning, 'kept reasoning');
    assert.equal(result.content, 'final answer');
    assert.deepEqual(transport.map(item => item.status), ['failed', 'succeeded']);
    assert.match(JSON.stringify(transport[0]), /discarded partial reasoning/);
    assert.doesNotMatch(JSON.stringify(raw), /discarded partial reasoning/);
    assert.equal(raw.filter(event => event.type === 'thinking').length, 2);
    const reasoning = cleaned.spans.find(span => span.kind === 'reasoning');
    assert.equal(reasoning.content, 'kept reasoning');
    assert.equal(reasoning.sourceEventIds.length, 2);
});

test('exhausted model transport attempts emit one infrastructure marker and no partial output', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-failed-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root);
    const model = {
        async *chat() {
            yield { type: 'thinking', content: 'partial' };
            const error = new Error('network timed out');
            error.code = 'ETIMEDOUT';
            throw error;
        },
    };
    const reliable = createReliableModelCapability(model, {
        recorder: journal,
        maxAttempts: 2,
        retryDelayMs: 0,
    });

    await assert.rejects(
        reliable.complete([{ role: 'user', content: 'task' }]),
        error => error.infrastructureFailure === true
    );
    const raw = readJsonl(journal.rawPath);
    assert.equal(readJsonl(journal.transportPath).length, 2);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].type, 'infra_failure');
    assert.doesNotMatch(JSON.stringify(raw), /partial/);
});

test('non-retryable model API failures are excluded as infrastructure after one HTTP attempt', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-auth-failed-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root);
    const model = {
        async *chat() {
            const error = new Error('authentication failed');
            error.status = 401;
            throw error;
        },
    };
    const reliable = createReliableModelCapability(model, {
        recorder: journal,
        maxAttempts: 3,
        retryDelayMs: 0,
    });

    await assert.rejects(
        reliable.complete([{ role: 'user', content: 'task' }]),
        error => error.infrastructureFailure === true
    );
    assert.equal(readJsonl(journal.transportPath).length, 1);
    const raw = readJsonl(journal.rawPath);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].type, 'infra_failure');
    assert.equal(raw[0].payload.attempts, 1);
});

test('a response without explicit reasoning is retried and never committed as task evidence', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-no-reasoning-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root);
    const model = {
        async *chat() {
            yield { type: 'content', content: 'answer without reasoning' };
        },
    };
    const reliable = createReliableModelCapability(model, {
        recorder: journal,
        maxAttempts: 2,
        retryDelayMs: 0,
    });

    await assert.rejects(
        reliable.complete([{ role: 'user', content: 'task' }]),
        error => error.code === 'MODEL_REASONING_MISSING'
            && error.infrastructureFailure === true
    );
    assert.equal(readJsonl(journal.transportPath).length, 2);
    const raw = readJsonl(journal.rawPath);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].type, 'infra_failure');
    assert.doesNotMatch(JSON.stringify(raw), /answer without reasoning/);
});

test('hung model streams are aborted, retried, and classified as infrastructure', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-timeout-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root);
    let calls = 0;
    const model = {
        async *chat(_messages, options) {
            calls += 1;
            await new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.code = 'ABORT_ERR';
                    reject(error);
                }, { once: true });
            });
            yield { type: 'thinking', content: 'unreachable' };
        },
    };
    const reliable = createReliableModelCapability(model, {
        recorder: journal,
        maxAttempts: 2,
        retryDelayMs: 0,
        requestTimeoutMs: 10,
    });

    await assert.rejects(
        reliable.complete([{ role: 'user', content: 'task' }]),
        error => error.code === 'MODEL_REQUEST_TIMEOUT'
            && error.infrastructureFailure === true
    );
    assert.equal(calls, 2);
    assert.deepEqual(
        readJsonl(journal.transportPath).map(item => item.errorCode),
        ['MODEL_REQUEST_TIMEOUT', 'MODEL_REQUEST_TIMEOUT']
    );
    assert.equal(readJsonl(journal.rawPath).filter(item => item.type === 'infra_failure').length, 1);
});

test('trajectory cleaning stores oversized reasoning losslessly in a content-addressed blob', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-blob-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root, { maxInlineChars: 8 });
    journal.recordSemanticEvent({
        eventId: 'reasoning-1',
        logicalCallId: 'call-1',
        type: 'thinking',
        content: 'complete reasoning content',
    });

    const span = journal.clean().spans[0];
    assert.equal(span.content, null);
    assert.equal(span.blobRef.chars, 'complete reasoning content'.length);
    assert.equal(fs.readFileSync(span.blobRef.path, 'utf8'), 'complete reasoning content');
});

test('trajectory cleaning pairs tool calls and results without removing model reasoning', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-trajectory-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new TrajectoryJournal(root);
    journal.recordSemanticEvent({
        eventId: 'reasoning',
        logicalCallId: 'model-call',
        type: 'thinking',
        content: 'inspect before editing',
    });
    journal.recordSemanticEvent({
        eventId: 'tool-start',
        type: 'tool_started',
        content: null,
        payload: { toolCallId: 'tool-1', name: 'sandbox_exec', arguments: { command: 'test' } },
    });
    journal.recordSemanticEvent({
        eventId: 'tool-result',
        type: 'tool_result',
        content: '{"exitCode":0}',
        payload: { toolCallId: 'tool-1', name: 'sandbox_exec', status: 'succeeded' },
    });

    const spans = journal.clean().spans;
    assert.equal(spans.find(span => span.kind === 'reasoning').content, 'inspect before editing');
    const tool = spans.find(span => span.kind === 'tool');
    assert.equal(tool.status, 'succeeded');
    assert.equal(tool.content, '{"exitCode":0}');
    assert.deepEqual(tool.sourceEventIds, ['tool-start', 'tool-result']);
});
