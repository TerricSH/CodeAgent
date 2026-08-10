const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig, buildRunArgs } = require('../plugins/docker-sandbox/policy');
const { DockerSandboxService } = require('../plugins/docker-sandbox/service');
const { runProcess } = require('../sandbox/docker-client');
const { DockerSandboxExecutor } = require('../sandbox/executor');
const { ensureContainedDirectory } = require('../sandbox/workspace');
const { SandboxEvaluator } = require('../skill-refinement/evaluator');

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
    const result = await sandbox.execute({ command: 'printf "safe"', timeoutMs: 5000 });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].at(-1), 'printf "safe"');
    assert.equal(calls[0].at(-2), '-lc');
    assert.ok(fs.existsSync(sandbox.workspace));
});

test('sandbox consumers share the common Docker executor', () => {
    const config = normalizeConfig({
        sandboxRoot: path.join(os.tmpdir(), `codeagent-shared-executor-${Date.now()}`),
    });
    const client = {};
    const service = new DockerSandboxService('session-service', config, { client });
    const evaluator = new SandboxEvaluator('session-evaluator', config, { client });

    assert.ok(service.executor instanceof DockerSandboxExecutor);
    assert.ok(evaluator.executor instanceof DockerSandboxExecutor);
});

test('common Docker executor owns engine and image readiness checks', async () => {
    const config = normalizeConfig({
        sandboxRoot: path.join(os.tmpdir(), `codeagent-executor-status-${Date.now()}`),
    });
    const calls = [];
    const executor = new DockerSandboxExecutor({
        config,
        session: 'status-session',
        client: {
            async version(options) {
                calls.push(['version', options]);
                return { exitCode: 0, stdout: '27.0.0\n', stderr: '', error: null };
            },
            async inspectImage(image, options) {
                calls.push(['image', image, options]);
                return { exitCode: 0, stdout: 'sha256:image\n', stderr: '', error: null };
            },
        },
    });

    assert.deepEqual(await executor.status(), {
        available: true,
        version: '27.0.0',
        imageReady: true,
        image: config.image,
        imageId: 'sha256:image',
        error: null,
    });
    assert.equal(calls.length, 2);
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
    assert.equal(fs.existsSync(path.join(outside, 'workspace')), false);
});
