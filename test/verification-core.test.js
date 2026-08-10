const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager } = require('../workspace');
const {
    VerifierRegistry,
    VerificationEngine,
    createPlan,
    createDefaultVerifierRegistry,
} = require('../verification-core');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const capabilities = new WorkspaceManager({ root }).createRuntimeCapabilities();
    return { root, capabilities };
}

test('verification plans are stable, deeply frozen, conjunctive, and provider types are unique', () => {
    const input = {
        checks: [
            { type: 'file', id: 'artifact', path: 'result.txt', nonEmpty: true },
            { id: 'tests', command: 'npm test', type: 'command' },
        ],
    };
    const first = createPlan(input);
    const second = createPlan({ checks: input.checks.map(check => ({ ...check })) });

    assert.equal(first.hash, second.hash);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.checks), true);
    assert.equal(Object.isFrozen(first.checks[0]), true);
    assert.throws(() => createPlan({ checks: [] }), /non-empty/);
    assert.throws(
        () => new VerifierRegistry([{ type: 'x', verify() {} }, { type: 'x', verify() {} }]),
        /Duplicate verification provider/
    );
});

test('the public registry accepts a custom deterministic provider without core changes', async () => {
    const registry = createDefaultVerifierRegistry([{
        type: 'custom-ci',
        verify(check) {
            return {
                status: check.config.result === 'green' ? 'PASS' : 'FAIL',
                summary: `CI result: ${check.config.result}`,
                evidence: { buildId: check.config.buildId },
            };
        },
    }]);
    const plan = createPlan({ checks: [
        { id: 'ci', type: 'custom-ci', config: { result: 'green', buildId: 42 } },
    ] });
    const outcome = await new VerificationEngine(registry).run(plan);

    assert.equal(outcome.status, 'PASS');
    assert.equal(outcome.checks[0].evidence.buildId, 42);
});

test('file and JSON providers return deterministic evidence', async (t) => {
    const { root, capabilities } = fixture(t);
    fs.writeFileSync(path.join(root, 'result.txt'), 'verified output', 'utf8');
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: true, nested: { count: 2 } }), 'utf8');
    const plan = createPlan({
        checks: [
            { id: 'text', type: 'file', path: 'result.txt', kind: 'file', nonEmpty: true, contains: 'verified', matches: '^verified' },
            { id: 'json', type: 'json', path: 'result.json', assertions: [
                { pointer: '/ok', valueType: 'boolean', equals: true },
                { pointer: '/nested/count', valueType: 'number', equals: 2 },
            ] },
        ],
    });
    const engine = new VerificationEngine(createDefaultVerifierRegistry());
    const outcome = await engine.run(plan, capabilities);

    assert.equal(outcome.status, 'PASS');
    assert.ok(outcome.checks.every(check => check.status === 'PASS'));
});

test('one failed check fails the complete verification plan', async (t) => {
    const { root, capabilities } = fixture(t);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: false }), 'utf8');
    const plan = createPlan({ checks: [
        { id: 'missing-text', type: 'file', path: 'missing.txt', exists: true },
        { id: 'json', type: 'json', path: 'result.json', assertions: [{ pointer: '/ok', equals: true }] },
    ] });
    const outcome = await new VerificationEngine(createDefaultVerifierRegistry()).run(plan, capabilities);

    assert.equal(outcome.status, 'FAIL');
    assert.equal(outcome.checks.length, 2);
    assert.ok(outcome.checks.some(check => check.status === 'FAIL'));
});

test('command provider uses commandScope and reports exit status or missing capability', async (t) => {
    const { capabilities } = fixture(t);
    const registry = createDefaultVerifierRegistry();
    const pass = await new VerificationEngine(registry).run(createPlan({ checks: [
        { id: 'pass', type: 'command', command: 'node -e "process.exit(0)"' },
    ] }), capabilities);
    const fail = await new VerificationEngine(registry).run(createPlan({ checks: [
        { id: 'fail', type: 'command', command: 'node -e "process.exit(7)"' },
    ] }), capabilities);
    const unavailable = await new VerificationEngine(registry).run(createPlan({ checks: [
        { id: 'unknown', type: 'command', command: 'node -v' },
    ] }), {});

    assert.equal(pass.status, 'PASS');
    assert.equal(fail.status, 'FAIL');
    assert.equal(fail.checks[0].evidence.exitCode, 7);
    assert.equal(unavailable.status, 'INCONCLUSIVE');
});

test('command provider deterministically fails a timed-out check', async (t) => {
    const capabilities = new WorkspaceManager({ root: process.cwd() }).createRuntimeCapabilities();
    const outcome = await new VerificationEngine(createDefaultVerifierRegistry()).run(createPlan({ checks: [
        {
            id: 'timeout',
            type: 'command',
            command: 'node -e "setTimeout(function () {}, 500)"',
            timeoutMs: 100,
        },
    ] }), capabilities);

    assert.equal(outcome.status, 'FAIL');
    assert.equal(outcome.checks[0].evidence.timedOut, true);
});
