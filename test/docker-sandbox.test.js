const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig, buildPersistentContainerArgs } = require('../plugins/docker-sandbox/policy');
const { DockerSandboxService } = require('../plugins/docker-sandbox/service');
const { runProcess } = require('../sandbox/docker-client');
const { SandboxPool } = require('../sandbox');
const { ensureContainedDirectory } = require('../sandbox/workspace');
const { SandboxEvaluator } = require('../skill-refinement/evaluator');

test('sandbox policy emits persistent CoW isolation and oversubscription limits', () => {
    const config = normalizeConfig({ sandboxRoot: path.join(os.tmpdir(), 'codeagent-policy') });
    const args = buildPersistentContainerArgs({
        config,
        containerName: 'sandbox-name',
        session: 'session-key',
        image: 'codeagent-snapshot:test',
    });
    const text = args.join(' ');

    assert.match(text, /--network none/);
    assert.match(text, /--cap-drop ALL/);
    assert.match(text, /--security-opt no-new-privileges/);
    assert.match(text, /--pids-limit 128/);
    assert.match(text, /--memory 512m/);
    assert.match(text, /--memory-reservation 128m/);
    assert.match(text, /--memory-swap 512m/);
    assert.match(text, /--storage-opt size=1g/);
    assert.match(text, /--cpus 1/);
    assert.equal(args.at(-4), 'codeagent-snapshot:test');
    assert.equal(args.at(-3), '/bin/sh');
    assert.equal(args.at(-2), '-lc');
    assert.match(args.at(-1), /sleep 3600/);
});

test('sandbox service passes commands as Docker arguments and returns structured results', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-sandbox-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls = [];
    const client = {
        async buildSnapshotImage(spec) { calls.push(['build', spec]); },
        async createContainer(args) {
            calls.push(['create', args]);
            return { exitCode: 0, error: null };
        },
        async startContainer(name) { calls.push(['start', name]); },
        async execContainer(name, command) {
            calls.push(['exec', name, command]);
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
        async inspectContainerState() { return { oomKilled: false }; },
        async stopContainer(name) { calls.push(['stop', name]); },
        async copyFromContainer(name, source, destination) {
            calls.push(['copy', name, source, destination]);
        },
        async removeContainer(name) { calls.push(['remove', name]); },
        async removeImage(image) { calls.push(['remove-image', image]); },
    };
    const sandbox = new DockerSandboxService('session-1', { sandboxRoot: root }, { client });
    const result = await sandbox.execute({ command: 'printf "safe"', timeoutMs: 5000 });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(calls.filter(call => call[0] === 'build').length, 1);
    assert.equal(calls.filter(call => call[0] === 'create').length, 1);
    assert.equal(calls.find(call => call[0] === 'exec')[2], 'printf "safe"');
    assert.equal(calls.filter(call => call[0] === 'stop').length, 1);
    assert.ok(fs.existsSync(sandbox.workspace));
    await sandbox.dispose();
});

test('sandbox policy rejects impossible memory and disk limits', () => {
    assert.throws(
        () => normalizeConfig({ memory: '128m', memoryReservation: '256m' }),
        /reservation cannot exceed/
    );
    assert.throws(
        () => normalizeConfig({ writableLayerSize: 'unbounded' }),
        /writable layer size/
    );
});

test('sandbox consumers share the public SandboxPool abstraction', () => {
    const config = normalizeConfig({
        sandboxRoot: path.join(os.tmpdir(), `codeagent-shared-executor-${Date.now()}`),
    });
    const client = {};
    const service = new DockerSandboxService('session-service', config, { client });
    const evaluator = new SandboxEvaluator('session-evaluator', config, { client });

    assert.ok(service.pool instanceof SandboxPool);
    assert.ok(evaluator.pool instanceof SandboxPool);
    assert.equal(evaluator.pool.client, service.pool.client);
});

test('public SandboxPool owns engine and image readiness checks', async () => {
    const config = normalizeConfig({
        sandboxRoot: path.join(os.tmpdir(), `codeagent-executor-status-${Date.now()}`),
    });
    const calls = [];
    const pool = new SandboxPool(config, {
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

    const status = await pool.status();
    assert.equal(status.available, true);
    assert.equal(status.version, '27.0.0');
    assert.equal(status.imageReady, true);
    assert.equal(status.image, config.image);
    assert.equal(status.imageId, 'sha256:image');
    assert.equal(status.error, null);
    assert.deepEqual(status.pool, {
        limit: 8,
        active: 0,
        queued: 0,
        leases: 0,
        snapshots: 0,
        peakActive: 0,
    });
    assert.deepEqual(status.resources, {
        configuredMaxActive: 8,
        effectiveMaxActive: 8,
        hardMemory: '512m',
        memoryReservation: '128m',
        engineMemoryFraction: 0.75,
        writableLayerSize: '1g',
        diskHighWatermark: 0.85,
        network: 'none',
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

test('SandboxPool runs different leases concurrently while preserving the active limit', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-pool-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let executing = 0;
    let peak = 0;
    const calls = [];
    const client = {
        async engineInfo() { return { memoryBytes: 1024 * 1024 * 1024 }; },
        async diskUsage() { return { fractionUsed: 0.2 }; },
        async buildSnapshotImage(spec) { calls.push(['build', spec.image]); },
        async createContainer(args) {
            calls.push(['create', args]);
            return { exitCode: 0, error: null };
        },
        async startContainer(name) { calls.push(['start', name]); },
        async execContainer(name, command) {
            executing += 1;
            peak = Math.max(peak, executing);
            await new Promise(resolve => setTimeout(resolve, 20));
            executing -= 1;
            return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: command,
                stderr: '',
                truncated: false,
                error: null,
                durationMs: 20,
            };
        },
        async inspectContainerState() { return { oomKilled: false }; },
        async stopContainer(name) { calls.push(['stop', name]); },
        async removeContainer(name) { calls.push(['remove', name]); },
        async removeImage(image) { calls.push(['remove-image', image]); },
    };
    const config = normalizeConfig({ sandboxRoot: root, maxActive: 2 });
    const pool = new SandboxPool(config, { client, session: 'parallel' });
    await pool.initialize();
    const snapshot = await pool.prepareSnapshot({ source: root, snapshotId: 'baseline' });
    const leases = await Promise.all([
        pool.acquire(snapshot, { item: 1 }),
        pool.acquire(snapshot, { item: 2 }),
        pool.acquire(snapshot, { item: 3 }),
    ]);
    assert.equal(calls.filter(call => call[0] === 'start').length, 0,
        'containers remain stopped while models are thinking');

    const results = await Promise.all(leases.map((lease, index) => lease.exec({
        command: `command-${index + 1}`,
    })));

    assert.equal(peak, 2);
    assert.equal(pool.stats().peakActive, 2);
    assert.deepEqual(results.map(result => result.failureType), ['success', 'success', 'success']);
    assert.equal(new Set(leases.map(lease => lease.containerName)).size, 3);
    assert.equal(calls.filter(call => call[0] === 'start').length, 3);
    assert.equal(calls.filter(call => call[0] === 'stop').length, 3);

    await Promise.all(leases.map(lease => lease.dispose()));
    await pool.disposeSnapshot(snapshot);
    await pool.dispose();
});

test('SandboxPool overcommits hard memory by reservation and blocks new leases at disk high water', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-pool-budget-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let diskFraction = 0.2;
    let creates = 0;
    const client = {
        async engineInfo() { return { memoryBytes: 512 * 1024 * 1024 }; },
        async diskUsage() { return { fractionUsed: diskFraction }; },
        async buildSnapshotImage() {},
        async createContainer() {
            creates += 1;
            return { exitCode: 0, error: null };
        },
        async removeContainer() {},
        async removeImage() {},
    };
    const pool = new SandboxPool(normalizeConfig({
        sandboxRoot: root,
        maxActive: 8,
        memory: '512m',
        memoryReservation: '128m',
        engineMemoryFraction: 0.75,
        diskHighWatermark: 0.85,
    }), { client, session: 'budget', diskCheckIntervalMs: 0 });
    const snapshot = await pool.prepareSnapshot({ source: root });
    assert.equal(pool.stats().limit, 3,
        'snapshot preparation applies the engine memory budget before any lease is created');
    const lease = await pool.acquire(snapshot);
    assert.equal(creates, 1);
    await lease.dispose();

    diskFraction = 0.9;
    await assert.rejects(pool.acquire(snapshot), error => error.code === 'SANDBOX_DISK_PRESSURE');
    assert.equal(creates, 1, 'disk pressure is checked before container creation');
    await pool.disposeSnapshot(snapshot);
    await pool.dispose();
});

test('SandboxPool serializes commands within a lease and reduces concurrency after OOM', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-pool-oom-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let running = false;
    let sequence = 0;
    const client = {
        async buildSnapshotImage() {},
        async createContainer() { return { exitCode: 0, error: null }; },
        async startContainer() {
            assert.equal(running, false);
            running = true;
        },
        async execContainer() {
            sequence += 1;
            return {
                exitCode: sequence === 1 ? 137 : 0,
                signal: null,
                timedOut: false,
                stdout: '',
                stderr: '',
                truncated: false,
                error: null,
                durationMs: 1,
            };
        },
        async inspectContainerState() { return { oomKilled: sequence === 1 }; },
        async stopContainer() { running = false; },
        async removeContainer() {},
        async removeImage() {},
    };
    const pool = new SandboxPool(normalizeConfig({ sandboxRoot: root, maxActive: 8 }), {
        client,
        session: 'oom',
    });
    const snapshot = await pool.prepareSnapshot({ source: root });
    const lease = await pool.acquire(snapshot);
    const first = lease.exec({ command: 'first' });
    const second = lease.exec({ command: 'second' });

    assert.equal((await first).failureType, 'oom');
    assert.equal((await second).failureType, 'success');
    assert.equal(pool.stats().limit, 4);
    await lease.dispose();
    await pool.disposeSnapshot(snapshot);
    await pool.dispose();
});
