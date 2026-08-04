const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Context = require('../context');
const PluginRegistry = require('../plugins/registry');
const dockerSandboxPlugin = require('../plugins/docker-sandbox');
const trajectoryRecorderPlugin = require('../plugins/trajectory-recorder');
const rewardEvaluatorPlugin = require('../plugins/reward-evaluator');

function memoryStoreFactory() {
    const states = new Map();
    return () => ({
        read: (sessionId) => states.get(sessionId) || null,
        write: (sessionId, value) => states.set(sessionId, value),
    });
}

test('RL plugins retain registry namespacing and attach evaluation rewards to trajectories', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-rl-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const registry = new PluginRegistry({ storeFactory: memoryStoreFactory() });
    registry.register(dockerSandboxPlugin, { sandboxRoot: path.join(root, 'sandboxes') });
    registry.register(trajectoryRecorderPlugin, { exportRoot: path.join(root, 'exports') });
    registry.register(rewardEvaluatorPlugin);

    const context = new Context('system', {
        sessionId: 'rl-session',
        resolveExtension: (name) => registry.resolveApi(name),
    });
    context.addUser('Make the tests pass');
    await registry.init(context);

    const names = registry.getTools(context).map((tool) => tool.definition.function.name);
    assert.ok(names.includes('docker-sandbox__sandbox_exec'));
    assert.ok(names.includes('docker-sandbox__sandbox_training_suites'));
    assert.ok(names.includes('docker-sandbox__sandbox_training_start'));
    assert.ok(names.includes('docker-sandbox__sandbox_training_history'));
    assert.ok(names.includes('docker-sandbox__sandbox_training_result'));
    assert.ok(names.includes('trajectory-recorder__trajectory_export'));
    assert.ok(names.includes('reward-evaluator__reward_summary'));

    await registry.onBeforeTurn(context);
    const toolCall = {
        id: 'call-1',
        name: 'docker-sandbox__sandbox_exec',
        arguments: { command: 'npm test', purpose: 'evaluation' },
    };
    const result = JSON.stringify({
        ok: true,
        exitCode: 0,
        timedOut: false,
        durationMs: 25,
    });
    await registry.onToolResult(context, toolCall, result);
    await registry.onAfterTurn(context, { reply: 'Tests pass.' });

    const recorder = context.getExtension('trajectory-recorder');
    const trajectories = recorder.list({ limit: 10 });
    assert.equal(trajectories.length, 1);
    assert.equal(trajectories[0].reward, 1);
    assert.equal(trajectories[0].toolCallCount, 1);

    const exported = recorder.exportJsonl();
    assert.equal(exported.count, 1);
    const record = JSON.parse(fs.readFileSync(exported.file, 'utf8').trim());
    assert.equal(record.reward, 1);
    assert.equal(record.rewards[0].reason, 'evaluation_passed');

    await registry.dispose(context, { reason: 'test' });
});

test('ordinary sandbox work does not create reward signals', async () => {
    const evaluator = new (require('../plugins/reward-evaluator/service').RewardEvaluator)();
    const signal = evaluator.evaluate({
        name: 'docker-sandbox__sandbox_exec',
        arguments: { command: 'ls', purpose: 'work' },
    }, JSON.stringify({ ok: true, exitCode: 0 }));

    assert.equal(signal, null);
    assert.equal(evaluator.summary().count, 0);
});
