const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    modelPackage,
    ModelPackageManager,
    TrainingContractError,
} = require('../training');

function createPackage(root, manifestOverrides = {}) {
    const packageDir = path.join(root, 'python-code-model');
    fs.mkdirSync(path.join(packageDir, 'checkpoints', 'base'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'tokenizer'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'chat-template.jinja'), '{{ messages }}', 'utf8');
    fs.copyFileSync(
        path.join(__dirname, 'fixtures', 'python-training-worker.py'),
        path.join(packageDir, 'worker.py')
    );
    const manifest = {
        schemaVersion: 1,
        id: 'python-code-model',
        artifacts: {
            checkpoint: 'checkpoints/base',
            tokenizer: 'tokenizer',
            chatTemplate: 'chat-template.jinja',
        },
        worker: {
            command: 'python',
            entry: 'worker.py',
            args: [],
            timeoutMs: 10000,
            env: { PYTHONUNBUFFERED: '1' },
        },
        capabilities: {
            generate: true,
            trainable: true,
            checkpoint: true,
        },
        algorithms: [{
            id: 'python-train',
            default: true,
            requirements: ['trainable', 'checkpoint'],
        }],
        ...manifestOverrides,
    };
    fs.writeFileSync(
        path.join(packageDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
    );
    return packageDir;
}

function trajectory() {
    return {
        id: 'trajectory-python-1',
        input: { content: 'train with Python' },
        toolCalls: [],
        rewards: [{ value: 1, source: 'test' }],
        reward: 1,
        finalReply: 'done',
    };
}

test('model package manifests cannot reference artifacts outside their directory', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-model-package-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const packageDir = createPackage(root);
    const manifest = JSON.parse(
        fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8')
    );
    manifest.artifacts.checkpoint = '../outside';

    assert.throws(
        () => modelPackage.validateManifest(manifest, packageDir),
        (error) => error instanceof TrainingContractError && /escapes/.test(error.message)
    );
});

test('package discovery reports invalid packages without blocking valid ones', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-discovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    createPackage(root);
    const invalid = path.join(root, 'invalid-model');
    fs.mkdirSync(invalid);
    fs.writeFileSync(
        path.join(invalid, 'manifest.json'),
        JSON.stringify({ schemaVersion: 1, id: 'invalid-model' }),
        'utf8'
    );

    const discovered = modelPackage.discoverModelPackages(root);
    assert.equal(discovered.packages.length, 1);
    assert.equal(discovered.packages[0].model.id, 'python-code-model');
    assert.equal(discovered.errors.length, 1);
    discovered.packages[0].worker.dispose();
});

test('packaged Python worker receives trajectories and performs the training step', async (t) => {
    const python = spawnSync('python', ['--version'], { windowsHide: true });
    if (python.error || python.status !== 0) {
        t.skip('python command is unavailable');
        return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-python-training-'));
    createPackage(root);
    const manager = new ModelPackageManager({ root });
    t.after(async () => {
        await manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const listed = manager.discover();
    assert.equal(listed.models.length, 1);
    assert.equal(listed.models[0].defaultAlgorithmId, 'python-code-model/python-train');
    assert.equal(manager.discover().models.length, 1);
    assert.equal(manager.list().errors.length, 0);
    assert.equal(
        manager.check('python-code-model').compatible,
        true
    );

    const run = await manager.train(
        { modelId: 'python-code-model' },
        [trajectory()]
    );
    assert.equal(run.status, 'completed');
    assert.equal(run.result.algorithmId, 'python-train');
    assert.equal(run.result.trajectoryCount, 1);
    assert.equal(run.result.loss, 0.125);
});
