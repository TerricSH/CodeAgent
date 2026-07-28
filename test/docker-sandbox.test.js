const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeConfig, buildRunArgs } = require('../plugins/docker-sandbox/policy');
const { DockerSandboxService } = require('../plugins/docker-sandbox/service');
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
