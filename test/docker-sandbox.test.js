const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeConfig, buildRunArgs } = require('../plugins/docker-sandbox/policy');
const {
    DockerSandboxService,
    ensureContainedDirectory,
} = require('../plugins/docker-sandbox/service');
const { runProcess } = require('../plugins/docker-sandbox/docker-client');

test('sandbox policy emits the required isolation flags', () => {
    const config = normalizeConfig({ sandboxRoot: path.join(os.tmpdir(), 'codeagent-policy') });
    const args = buildRunArgs({
        config,
        containerName: 'sandbox-name',
        session: 'session-key',
        workspace: path.join(os.tmpdir(), 'codeagent-policy', 'workspace'),
        command: 'node --version',
    });
    const text = args.join(' ');

    assert.match(text, /--network none/);
    assert.match(text, /--read-only/);
    assert.match(text, /--cap-drop ALL/);
    assert.match(text, /--security-opt no-new-privileges/);
    assert.match(text, /--pids-limit 128/);
    assert.match(text, /--memory 512m/);
    assert.match(text, /--memory-swap 512m/);
    assert.match(text, /--cpus 1/);
    assert.equal(args.at(-3), '/bin/sh');
    assert.equal(args.at(-2), '-lc');
    assert.equal(args.at(-1), 'node --version');
});

test('sandbox service passes commands as Docker arguments and returns structured results', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-sandbox-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls = [];
    const client = {
        async run(args) {
            calls.push(args);
            return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: 'ok\n',
                stderr: '',
                truncated: false,
                error: null,
                durationMs: 12,
            };
        },
        async removeContainer() {
            throw new Error('cleanup should not run for successful commands');
        },
    };
    const sandbox = new DockerSandboxService('session-1', { sandboxRoot: root }, { client });
    const result = await sandbox.execute({
        command: 'printf "safe"',
        purpose: 'evaluation',
        timeoutMs: 5000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.purpose, 'evaluation');
    assert.equal(result.stdout, 'ok\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].at(-1), 'printf "safe"');
    assert.equal(calls[0].at(-2), '-lc');
    assert.ok(fs.existsSync(sandbox.workspace));
});

test('missing executables resolve to a diagnostic result', async () => {
    const result = await runProcess(`definitely-missing-codeagent-${Date.now()}`, [], {
        timeoutMs: 1000,
        maxOutputBytes: 1024,
    });
    assert.equal(result.exitCode, null);
    assert.ok(result.error);
});

test('sandbox rejects a workspace whose real path escapes through a link', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-realpath-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-realpath-outside-'));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    const link = path.join(root, 'linked');
    try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`symbolic links are unavailable: ${error.message}`);
        return;
    }
    assert.throws(
        () => ensureContainedDirectory(root, path.join(link, 'workspace')),
        /escaped its configured root/
    );
});

test('training suites run isolated rollouts, reject protected changes, and select the best candidate', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-training-'));
    const project = path.join(root, 'project');
    const sandboxRoot = path.join(root, 'sandboxes');
    const suitesRoot = path.join(project, 'training', 'suites');
    const suiteDir = path.join(suitesRoot, 'sample-suite');
    fs.mkdirSync(path.join(project, 'test'), { recursive: true });
    fs.mkdirSync(path.join(project, 'model-providers'), { recursive: true });
    fs.mkdirSync(suiteDir, { recursive: true });
    fs.writeFileSync(path.join(project, 'source.js'), 'module.exports = 1;\n', 'utf8');
    fs.writeFileSync(path.join(project, '.env'), 'API_KEY=must-not-enter-rollouts\n', 'utf8');
    fs.writeFileSync(
        path.join(project, 'model-providers', 'config.json'),
        '{"secret":true}\n',
        'utf8'
    );
    fs.writeFileSync(path.join(project, 'test', 'locked.test.js'), 'trusted\n', 'utf8');
    fs.writeFileSync(path.join(suiteDir, 'seed.md'), 'Prefer small correct patches.\n', 'utf8');
    fs.writeFileSync(path.join(suiteDir, 'suite.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'sample-suite',
        task: 'Improve source.js without changing protected tests.',
        baseline: '.',
        skillPath: 'seed.md',
        rollouts: 3,
        protectedPaths: ['test'],
        evaluation: { command: 'node verify.js', timeoutMs: 5000 },
    }, null, 2), 'utf8');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const dockerCalls = [];
    const client = {
        async run(args) {
            dockerCalls.push(args);
            return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: 'trusted evaluation passed\n',
                stderr: '',
                truncated: false,
                error: null,
                durationMs: 20,
            };
        },
        async removeContainer() {},
    };
    const rolloutExecutor = async ({ rolloutId, workspace }) => {
        assert.equal(fs.existsSync(path.join(workspace, '.env')), false);
        assert.equal(fs.existsSync(path.join(workspace, 'model-providers', 'config.json')), false);
        if (rolloutId === 'rollout-001') {
            fs.writeFileSync(path.join(workspace, 'solution.js'), 'ok\n', 'utf8');
        } else if (rolloutId === 'rollout-002') {
            fs.writeFileSync(
                path.join(workspace, 'solution.js'),
                'a substantially larger but passing candidate\n',
                'utf8'
            );
        } else {
            fs.writeFileSync(path.join(workspace, 'solution.js'), 'tiny\n', 'utf8');
            fs.writeFileSync(path.join(workspace, 'test', 'locked.test.js'), 'tampered\n', 'utf8');
        }
        return {
            reply: `completed ${rolloutId}`,
            messages: [{ role: 'assistant', content: `completed ${rolloutId}` }],
        };
    };
    const sandbox = new DockerSandboxService('training-session', {
        sandboxRoot,
        projectRoot: project,
        suitesRoot,
    }, { client, rolloutExecutor });

    const listed = sandbox.listTrainingSuites();
    assert.equal(listed.suites.length, 1);
    assert.equal(listed.suites[0].id, 'sample-suite');

    const result = await sandbox.startTraining({ suiteId: 'sample-suite' });
    assert.equal(result.run.status, 'completed');
    assert.equal(result.ranking.length, 3);
    assert.equal(result.best.rolloutId, 'rollout-001');
    assert.equal(result.best.score, 1);
    assert.equal(result.ranking.at(-1).rolloutId, 'rollout-003');
    assert.deepEqual(result.ranking.at(-1).protectedPathViolations, ['test']);
    assert.equal(dockerCalls.length, 2, 'protected rollout must not reach the evaluator');
    assert.notEqual(
        result.best.workspace,
        path.join(result.run.artifactRoot, 'rollouts', 'rollout-002', 'workspace')
    );

    const records = fs.readFileSync(result.skillOptInput, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 3);
    assert.equal(records[0].suiteId, 'sample-suite');
    assert.equal(records[2].reward, -1);
    assert.equal(sandbox.trainingHistory()[0].bestRolloutId, 'rollout-001');
    assert.equal(sandbox.trainingResult(result.run.id).best.rolloutId, 'rollout-001');
});
