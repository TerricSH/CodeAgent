const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Context = require('../context');
const PluginRegistry = require('../plugins/registry');
const verificationGatePlugin = require('../plugins/verification-gate');
const { WorkspaceManager } = require('../workspace');
const tools = require('../tools');
const runAgentLoop = require('../agent-runner');
const SessionRuntime = require('../runtime/session-runtime');
const { VerificationGateState } = require('../plugins/verification-gate/state');
const { createDefaultRegistry } = require('../plugins');
const { buildSystemPrompt } = require('../system-prompt');

const APPROVE_PLAN = 'Approve verification plan';

async function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const auditWriter = {
        activeTraceId: options.traceId || 'trace-1',
        record(event) {
            const normalized = { traceId: event.traceId || this.activeTraceId, ...event };
            events.push(normalized);
            return normalized;
        },
        async flush() {},
        finishTrace() { this.activeTraceId = null; },
    };
    const outputCapability = options.collect ? { prompt: { collect: options.collect } } : undefined;
    const capabilities = {
        ...new WorkspaceManager({ root }).createRuntimeCapabilities(),
        ...(outputCapability ? { output: outputCapability } : {}),
    };
    const registry = new PluginRegistry({
        capabilities,
        ...(options.storeFactory ? { storeFactory: options.storeFactory } : {}),
    });
    registry.register(verificationGatePlugin, options.config || {});
    const systemPrompt = options.systemPrompt || options.basePrompt || 'system';
    const context = new Context(systemPrompt, {
        sessionId: options.sessionId || 'gate-session',
        auditWriter,
        resolveExtension: name => registry.resolveApi(name),
    });
    if (options.user) context.addUser(options.user);
    const tracePolicy = registry.deriveTracePolicy({
        basePrompt: options.basePrompt !== undefined ? options.basePrompt : systemPrompt,
        userContent: options.user || '',
    });
    context.startTask(auditWriter.activeTraceId, tracePolicy);
    await registry.init(context);
    const toolRegistry = tools.createRegistry(registry.getTools(context), {
        includeCore: false,
        capabilities,
        onBeforeBatch: (ctx, batch) => registry.onBeforeToolBatch(ctx, batch),
        onBeforeExecute: (ctx, tool, args) => registry.onBeforeToolExecute(ctx, tool, args),
    });
    return { root, events, registry, context, service: registry.resolveApi('verification-gate'), toolRegistry, auditWriter };
}

const passingPlan = () => ({ checks: [
    { id: 'artifact', type: 'file', path: 'artifact.txt', nonEmpty: true, contains: 'done' },
] });

test('base-system and current-user markers become immutable current-Trace policy', async (t) => {
    const system = await fixture(t, { basePrompt: 'policy\n<verification-gate mode="required"/>' });
    await system.registry.onBeforeTurn(system.context);
    assert.equal(system.service.current().source, 'system');
    assert.equal(system.context.taskPolicy['verification-gate'].required, true);

    const user = await fixture(t, { user: 'implement this\n<verification-gate mode="required"/>' });
    await user.registry.onBeforeTurn(user.context);
    assert.equal(user.service.current().source, 'user');

    const ordinary = await fixture(t);
    await ordinary.registry.onBeforeTurn(ordinary.context);
    assert.equal(ordinary.service.current(), null);
});

test('composed Tool prompt text cannot activate an ordinary Runtime Trace', async (t) => {
    const toolPrompt = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'verification-gate', 'prompt.md'), 'utf8');
    const systemPrompt = buildSystemPrompt({ basePrompt: 'ordinary policy', toolPrompts: toolPrompt });
    const gate = await fixture(t, { systemPrompt, basePrompt: 'ordinary policy' });
    await gate.registry.onBeforeTurn(gate.context);

    assert.equal(gate.service.current(), null);
});

test('effectful tools require a trusted or explicitly user-approved frozen plan', async (t) => {
    const gate = await fixture(t, { basePrompt: '<verification-gate mode="required"/>' });
    await gate.registry.onBeforeTurn(gate.context);
    const effectful = {
        definition: { type: 'function', function: { name: 'mutate', description: 'fixture', parameters: { type: 'object', properties: {} } } },
        effects: 'write',
        handler: () => 'mutated',
    };
    const readOnly = {
        definition: { type: 'function', function: { name: 'inspect', description: 'fixture', parameters: { type: 'object', properties: {} } } },
        effects: 'read',
        handler: () => 'inspected',
    };
    const registry = tools.createRegistry([effectful, readOnly], {
        includeCore: false,
        capabilities: {},
        onBeforeBatch: (ctx, batch) => gate.registry.onBeforeToolBatch(ctx, batch),
        onBeforeExecute: (ctx, tool, args) => gate.registry.onBeforeToolExecute(ctx, tool, args),
    });

    assert.equal(await registry.execute('inspect', {}, gate.context), 'inspected');
    await assert.rejects(() => registry.execute('mutate', {}, gate.context), error => error.code === 'VERIFICATION_PLAN_REQUIRED');
    gate.service.bindTrustedPlan(passingPlan(), { kind: 'host', id: 'test-policy' });
    assert.equal(await registry.execute('mutate', {}, gate.context), 'mutated');
    assert.throws(
        () => gate.service.bindTrustedPlan(passingPlan(), { kind: 'host' }),
        /already frozen/
    );
});

test('whole-batch preflight rejects plan plus write before either tool starts', async (t) => {
    const gate = await fixture(t, {
        basePrompt: '<verification-gate mode="required"/>',
        collect: async () => APPROVE_PLAN,
    });
    await gate.registry.onBeforeTurn(gate.context);
    const write = {
        definition: { type: 'function', function: { name: 'write_fixture', description: 'fixture', parameters: { type: 'object', properties: {} } } },
        effects: 'write',
        handler: () => 'written',
    };
    const registry = tools.createRegistry([write, ...gate.registry.getTools(gate.context)], {
        includeCore: false,
        capabilities: {},
        onBeforeBatch: (ctx, batch) => gate.registry.onBeforeToolBatch(ctx, batch),
        onBeforeExecute: (ctx, tool, args) => gate.registry.onBeforeToolExecute(ctx, tool, args),
    });
    const calls = [
        { id: 'plan', name: 'verification-gate__verification_gate', arguments: { action: 'plan', checks: passingPlan().checks } },
        { id: 'write', name: 'write_fixture', arguments: {} },
    ];

    await assert.rejects(() => registry.preflight(calls, gate.context), error => error.code === 'VERIFICATION_PLAN_REQUIRED');
    assert.equal(gate.service.current().planHash, null);

    await registry.preflight([calls[0]], gate.context);
    const proposal = JSON.parse(await registry.execute(calls[0].name, calls[0].arguments, gate.context));
    assert.equal(proposal.proposal.approved, true);
    await registry.preflight([calls[1]], gate.context);
    assert.equal(await registry.execute('write_fixture', {}, gate.context), 'written');
});

test('plan plus verify is an effectful mixed batch and cannot race plan freezing', async (t) => {
    const gate = await fixture(t, {
        basePrompt: '<verification-gate mode="required"/>',
        collect: async () => APPROVE_PLAN,
    });
    await gate.registry.onBeforeTurn(gate.context);
    const plan = {
        id: 'plan',
        name: 'verification-gate__verification_gate',
        arguments: { action: 'plan', checks: passingPlan().checks },
    };
    const verify = {
        id: 'verify',
        name: 'verification-gate__verification_gate',
        arguments: { action: 'verify' },
    };

    assert.equal(gate.toolRegistry.describe(plan.name, plan.arguments).effects, 'control');
    assert.equal(gate.toolRegistry.describe(verify.name, verify.arguments).effects, 'execute');
    await assert.rejects(
        () => gate.toolRegistry.preflight([plan, verify], gate.context),
        error => error.code === 'VERIFICATION_PLAN_REQUIRED'
    );
    assert.equal(gate.service.current().planHash, null);
});

test('formal completion authorization reruns all checks and persists compact evidence references', async (t) => {
    const gate = await fixture(t, { basePrompt: '<verification-gate mode="required"/>' });
    await gate.registry.onBeforeTurn(gate.context);
    gate.service.bindTrustedPlan(passingPlan(), { kind: 'host' });

    const blocked = await gate.registry.authorizeTraceCompletion(gate.context, { reply: 'done' });
    assert.equal(blocked.authorized, false);
    assert.match(blocked.reminder, /blocked completion/);
    fs.writeFileSync(path.join(gate.root, 'artifact.txt'), 'done', 'utf8');
    const allowed = await gate.registry.authorizeTraceCompletion(gate.context, { reply: 'done' });
    assert.equal(allowed.authorized, true);

    const stored = gate.service.state.list()[0];
    assert.equal(stored.latestAttempt.status, 'PASS');
    assert.ok(stored.latestAttempt.checks[0].evidenceRef.eventId);
    assert.equal(Object.prototype.hasOwnProperty.call(stored.latestAttempt.checks[0], 'evidence'), false);
    const completed = gate.events.filter(event => event.eventType === 'verification.completed').at(-1);
    assert.ok(completed.payload.checks.every(check => !Object.prototype.hasOwnProperty.call(check, 'evidence')));
});

test('the model can only propose a plan; exact direct user approval freezes it', async (t) => {
    const denied = await fixture(t, { collect: async () => 'free-form approval' });
    denied.service.declareRequired('agent');
    assert.equal((await denied.service.proposePlan(passingPlan())).approved, false);
    assert.equal(denied.service.current().planHash, null);

    const approved = await fixture(t, { collect: async () => APPROVE_PLAN });
    approved.service.declareRequired('agent');
    assert.equal((await approved.service.proposePlan(passingPlan())).approved, true);
    assert.equal(approved.service.current().planAuthority.kind, 'user-approved');
});

test('configured profiles are frozen without giving the model command selection authority', async (t) => {
    const gate = await fixture(t, {
        basePrompt: '<verification-gate mode="required" profile="project-tests"/>',
        config: { profiles: { 'project-tests': passingPlan() } },
    });
    await gate.registry.onBeforeTurn(gate.context);

    assert.equal(gate.service.current().profileId, 'project-tests');
    assert.equal(gate.service.current().planAuthority.kind, 'trusted-profile');
    assert.equal(gate.service.current().planAuthority.id, 'project-tests');
});

test('override requires exact interactive user approval and is consumed once', async (t) => {
    const denied = await fixture(t, { collect: async () => 'free-form approval' });
    denied.service.declareRequired('agent');
    assert.equal((await denied.service.requestOverride('cannot verify')).approved, false);

    const approved = await fixture(t, { collect: async () => 'Approve this override' });
    approved.service.declareRequired('agent');
    assert.equal((await approved.service.requestOverride('user requested cancellation')).approved, true);
    assert.doesNotThrow(() => approved.service.beforeToolExecute({ effects: 'write' }));
    assert.equal((await approved.service.authorizeCompletion()).status, 'OVERRIDDEN');
    assert.equal(approved.service.current().override.consumed, true);
    assert.throws(
        () => approved.service.beforeToolExecute({ effects: 'write' }),
        error => error.code === 'VERIFICATION_PLAN_REQUIRED'
    );
    assert.equal((await approved.service.authorizeCompletion()).authorized, false);
});

test('restoring an interrupted verification fails closed and preserves authority and plan hash', () => {
    const original = new VerificationGateState();
    original.require('trace-resume', 'system');
    const frozen = original.freezePlan('trace-resume', passingPlan(), { kind: 'host', id: 'restore-test' });
    original.beginVerification('trace-resume');
    const restored = new VerificationGateState();
    restored.restore(original.list());

    const record = restored.get('trace-resume');
    assert.equal(record.state, 'inconclusive');
    assert.equal(record.planHash, frozen.planHash);
    assert.equal(record.planAuthority.kind, 'host');
    assert.equal(Object.isFrozen(record.plan), true);
    assert.throws(
        () => restored.freezePlan('trace-resume', passingPlan(), { kind: 'host' }),
        /already frozen/
    );
});

test('a corrupt gate state degrades only the plugin; a new strong Trace still fails closed', async (t) => {
    const storeFactory = () => ({
        read: async () => '{broken-json',
        write: async () => {},
    });
    const ordinary = await fixture(t, { storeFactory });
    await ordinary.registry.onBeforeTurn(ordinary.context);
    assert.equal(ordinary.service.current(), null);

    const strong = await fixture(t, {
        storeFactory,
        basePrompt: '<verification-gate mode="required"/>',
    });
    await strong.registry.onBeforeTurn(strong.context);
    assert.ok(strong.service.current().degraded);
    const decision = await strong.registry.authorizeTraceCompletion(strong.context);
    assert.equal(decision.authorized, false);
    assert.equal(decision.decisions[0].status, 'INCONCLUSIVE');
});

test('protected final replies are rendered and committed only after authorization', async (t) => {
    const gate = await fixture(t, {
        basePrompt: '<verification-gate mode="required" profile="artifact"/>',
        config: { profiles: { artifact: passingPlan() } },
    });
    gate.context.addUser('finish the work', { beginTurn: false });
    const rendered = [];
    const noop = () => {};
    const output = {
        thinking: { renderStart: noop, render: noop, renderEnd: noop },
        content: { renderStart: noop, render: value => rendered.push(value), renderEnd: noop },
        tool: { renderCall: noop, renderResult: noop },
    };
    let request = 0;
    const afterTurnSnapshots = [];
    const originalAfterTurn = gate.registry.onAfterTurn.bind(gate.registry);
    gate.registry.onAfterTurn = async (context, state) => {
        afterTurnSnapshots.push(context.messages.map(message => message.content));
        return originalAfterTurn(context, state);
    };
    const client = {
        info: () => ({}),
        async *chat() {
            request += 1;
            if (request === 1) {
                yield { type: 'content', content: 'Premature done.' };
                return;
            }
            fs.writeFileSync(path.join(gate.root, 'artifact.txt'), 'done', 'utf8');
            yield { type: 'content', content: 'Verified done.' };
        },
    };

    const reply = await runAgentLoop(gate.context, output, {
        client,
        toolRegistry: tools.createRegistry([], { includeCore: false }),
        tools: [],
        plugins: gate.registry,
        audit: gate.auditWriter,
    });

    assert.equal(reply, 'Verified done.');
    assert.deepEqual(rendered, ['Verified done.']);
    assert.equal(gate.context.messages.some(message => message.content === 'Premature done.'), false);
    assert.equal(gate.context.messages.some(message => message.content === 'Verified done.'), true);
    assert.equal(afterTurnSnapshots.length, 1);
    assert.ok(afterTurnSnapshots[0].includes('Verified done.'));
});

test('Agent Runner blocks every call in a mixed unplanned batch before parallel execution', async (t) => {
    const gate = await fixture(t, {
        basePrompt: '<verification-gate mode="required"/>',
        collect: async () => 'Approve this override',
    });
    gate.context.addUser('perform guarded work', { beginTurn: false });
    let writes = 0;
    const write = {
        definition: { type: 'function', function: { name: 'write_fixture', description: 'fixture', parameters: { type: 'object', properties: {} } } },
        effects: 'write',
        handler: () => { writes += 1; return 'written'; },
    };
    const toolRegistry = tools.createRegistry([write, ...gate.registry.getTools(gate.context)], {
        includeCore: false,
        capabilities: {},
        onBeforeBatch: (ctx, batch) => gate.registry.onBeforeToolBatch(ctx, batch),
        onBeforeExecute: (ctx, tool, args) => gate.registry.onBeforeToolExecute(ctx, tool, args),
    });
    const noop = () => {};
    const output = {
        thinking: { renderStart: noop, render: noop, renderEnd: noop },
        content: { renderStart: noop, render: noop, renderEnd: noop },
        tool: { renderCall: noop, renderResult: noop },
    };
    let request = 0;
    const client = {
        info: () => ({}),
        async *chat() {
            request += 1;
            if (request === 1) {
                yield { type: 'tool_calls', calls: [
                    {
                        id: 'plan-call',
                        name: 'verification-gate__verification_gate',
                        arguments: { action: 'plan', checks: passingPlan().checks },
                    },
                    { id: 'write-call', name: 'write_fixture', arguments: {} },
                ] };
                return;
            }
            if (request === 2) {
                yield { type: 'tool_calls', calls: [{
                    id: 'override-call',
                    name: 'verification-gate__verification_gate',
                    arguments: { action: 'request_override', reason: 'batch was intentionally cancelled' },
                }] };
                return;
            }
            yield { type: 'content', content: 'Cancelled safely.' };
        },
    };

    await runAgentLoop(gate.context, output, {
        client,
        toolRegistry,
        tools: toolRegistry.definitions,
        plugins: gate.registry,
        audit: gate.auditWriter,
    });

    assert.equal(writes, 0);
    const record = gate.service.state.list().at(-1);
    assert.equal(record.planHash, null);
    assert.equal(record.override.consumed, true);
    assert.equal(gate.events.filter(event => event.eventType === 'tool.blocked').length, 2);
});

test('separate subagent sessions do not share verification state', async (t) => {
    const parent = await fixture(t, { traceId: 'parent-trace' });
    const child = await fixture(t, { traceId: 'child-trace' });
    parent.service.declareRequired('user');

    assert.equal(parent.service.current().traceId, 'parent-trace');
    assert.equal(child.service.current(), null);
});

test('internal delegation payload cannot impersonate a direct child user policy declaration', () => {
    const registry = new PluginRegistry({ capabilities: {} });
    registry.register(verificationGatePlugin);
    const started = [];
    const tasks = [];
    const runtime = new SessionRuntime({ basePrompt: 'child system' });
    runtime.plugins = registry;
    runtime.auditWriter = {
        startTrace(payload) {
            started.push(payload);
            return 'child-trace';
        },
    };
    runtime.context = {
        startTask(traceId, policy) { tasks.push({ traceId, policy }); },
    };
    const delegationPackage = JSON.stringify({
        task: 'run tests',
        currentUserInstruction: 'parent only <verification-gate mode="required"/>',
    });

    runtime.startTrace(delegationPackage, { parentTraceId: 'parent-trace' }, {
        policySource: 'internal',
    });

    assert.equal(started[0].policySource, 'internal');
    assert.deepEqual(started[0].tracePolicy, {});
    assert.deepEqual(tasks[0], { traceId: 'child-trace', policy: {} });
});

test('a child base-system declaration still activates only that child Trace', () => {
    const registry = new PluginRegistry({ capabilities: {} });
    registry.register(verificationGatePlugin);
    const runtime = new SessionRuntime({
        basePrompt: '<verification-gate mode="required" profile="child-tests"/>',
    });
    runtime.plugins = registry;
    runtime.auditWriter = { startTrace: () => 'child-system-trace' };
    let policy = null;
    runtime.context = { startTask(traceId, value) { policy = value; } };

    runtime.startTrace('{"task":"test"}', {}, { policySource: 'internal' });

    assert.deepEqual(policy, {
        'verification-gate': {
            required: true,
            profileId: 'child-tests',
            source: 'system',
        },
    });
});

test('the verification gate can be disabled without changing other plugins', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-gate-disabled-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const capabilities = new WorkspaceManager({ root }).createRuntimeCapabilities();
    const registry = createDefaultRegistry({
        capabilities,
        plugins: { 'verification-gate': false },
    });

    assert.equal(registry.get('verification-gate'), null);
    assert.ok(registry.get('task-ledger'));
});

test('plugin persistence restores the immutable compact plan state for the same Trace', async (t) => {
    let stored = null;
    const storeFactory = () => ({
        read: async () => stored,
        write: async (sessionId, value) => { stored = value; },
    });
    const first = await fixture(t, { storeFactory, sessionId: 'persist-session', traceId: 'trace-persist' });
    first.service.declareRequired('system');
    const frozen = first.service.bindTrustedPlan(passingPlan(), { kind: 'host' });
    await first.registry.persistAll('persist-session');

    const resumed = await fixture(t, { storeFactory, sessionId: 'persist-session', traceId: 'trace-persist' });
    assert.equal(resumed.service.current().planHash, frozen.planHash);
    assert.throws(
        () => resumed.service.bindTrustedPlan(passingPlan(), { kind: 'host' }),
        /already frozen/
    );
});
