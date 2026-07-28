const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TrainingRegistry,
    CapabilityMismatchError,
    TrainingContractError,
    defineModelAdapter,
    defineAlgorithmAdapter,
    createWorkerModelAdapter,
    schemas,
} = require('../training');

function trajectory(overrides = {}) {
    return {
        id: 'trajectory-1',
        sessionId: 'session-1',
        input: { content: 'Solve the task' },
        toolCalls: [],
        rewards: [{ value: 1, source: 'test', reason: 'passed' }],
        reward: 1,
        finalReply: 'Done',
        ...overrides,
    };
}

test('model adapters must implement every enabled standard capability', () => {
    assert.throws(() => defineModelAdapter({
        id: 'broken-model',
        capabilities: { generate: true },
    }), (error) => {
        assert.ok(error instanceof TrainingContractError);
        assert.match(error.message, /generate\(\)/);
        return true;
    });

    assert.throws(() => defineModelAdapter({
        id: 'broken-sampling-model',
        capabilities: { multipleSamples: true },
    }), /requires "generate"/);
});

test('registry rejects algorithms whose model capabilities are incomplete', () => {
    const registry = new TrainingRegistry();
    registry.registerModel({
        id: 'inference-only',
        capabilities: { generate: true },
        async generate() {
            return { samples: [{ content: 'answer' }] };
        },
    });
    registry.registerAlgorithm({
        id: 'grpo-like',
        requirements: ['generate', 'multipleSamples', 'tokenLogprobs', 'trainable'],
        prepareBatch(batch) {
            return batch;
        },
        async train() {
            return { ok: true };
        },
    });

    const compatibility = registry.compatibility('inference-only', 'grpo-like');
    assert.equal(compatibility.compatible, false);
    assert.deepEqual(compatibility.missing, ['multipleSamples', 'tokenLogprobs', 'trainable']);
    assert.throws(
        () => registry.bind('inference-only', 'grpo-like'),
        CapabilityMismatchError
    );
});

test('rollout requests cannot silently exceed model sampling capabilities', async () => {
    const registry = new TrainingRegistry();
    registry.registerModel({
        id: 'single-sample-model',
        capabilities: { generate: true },
        async generate() {
            return { samples: [{ content: 'answer' }] };
        },
    });
    registry.registerAlgorithm({
        id: 'inference-evaluation',
        requirements: ['generate'],
        prepareBatch(batch) {
            return batch;
        },
        async train() {
            return { ok: true };
        },
    });
    const binding = registry.bind('single-sample-model', 'inference-evaluation');

    await assert.rejects(() => binding.generate({
        messages: [{ role: 'user', content: 'task' }],
        sampling: { numSamples: 2, returnTokenLogprobs: true },
    }), (error) => {
        assert.ok(error instanceof CapabilityMismatchError);
        assert.deepEqual(error.missing, ['multipleSamples', 'tokenLogprobs']);
        return true;
    });
});

test('compatible model and algorithm bind through unified rollout and training methods', async () => {
    const calls = [];
    const model = defineModelAdapter({
        id: 'trainable-code-model',
        capabilities: {
            generate: true,
            multipleSamples: true,
            tokenize: true,
            tokenLogprobs: true,
            referencePolicy: true,
            trainable: true,
            checkpoint: true,
        },
        metadata: { family: 'test' },
        async generate(request) {
            calls.push(['generate', request]);
            return {
                samples: [
                    { content: 'candidate-a', tokenLogprobs: [-0.1] },
                    { content: 'candidate-b', tokenLogprobs: [-0.2] },
                ],
            };
        },
        async tokenize(payload) {
            return payload;
        },
        async computeLogprobs(payload) {
            return payload;
        },
        async computeReferenceLogprobs(payload) {
            return payload;
        },
        async trainStep(batch) {
            calls.push(['trainStep', batch]);
            return { loss: 0.25, checkpoint: 'step-1' };
        },
        async saveCheckpoint(payload) {
            return payload;
        },
        async loadCheckpoint(payload) {
            return payload;
        },
    });
    const algorithm = defineAlgorithmAdapter({
        id: 'group-policy',
        requirements: [
            'generate',
            'multipleSamples',
            'tokenize',
            'tokenLogprobs',
            'referencePolicy',
            'trainable',
            'checkpoint',
        ],
        validateConfig(config) {
            if (config.groupSize !== 2) throw new Error('groupSize must be 2');
        },
        prepareBatch(batch) {
            return { items: batch.trajectories, metadata: batch.metadata };
        },
        async train(batch, { model: boundModel }) {
            return await boundModel.trainStep(batch);
        },
    });
    const registry = new TrainingRegistry({ models: [model], algorithms: [algorithm] });
    const binding = registry.bind('trainable-code-model', 'group-policy', { groupSize: 2 });

    const rollout = await binding.generate({
        messages: [{ role: 'user', content: 'write code' }],
        sampling: { numSamples: 2 },
    });
    assert.equal(rollout.samples.length, 2);

    const trained = await binding.train([trajectory()]);
    assert.equal(trained.loss, 0.25);
    assert.equal(calls[0][0], 'generate');
    assert.equal(calls[1][0], 'trainStep');
    assert.equal(binding.describe().model.id, 'trainable-code-model');
});

test('worker model adapter routes enabled capabilities through one worker interface', async () => {
    const operations = [];
    const worker = {
        async request(operation, request) {
            operations.push([operation, request]);
            if (operation === 'generate') {
                return { samples: [{ content: 'worker answer' }] };
            }
            return { ok: true };
        },
    };
    const adapter = createWorkerModelAdapter({
        id: 'python-worker-model',
        capabilities: {
            generate: true,
            tokenize: true,
            tokenLogprobs: true,
            trainable: true,
            checkpoint: true,
        },
        worker,
    });

    await adapter.generate({ messages: [{ role: 'user', content: 'task' }] });
    await adapter.computeLogprobs({ tokenIds: [1, 2] });
    await adapter.trainStep({ items: [] });
    await adapter.saveCheckpoint({ path: 'checkpoint' });

    assert.deepEqual(
        operations.map(([operation]) => operation),
        ['generate', 'compute_logprobs', 'train_step', 'save_checkpoint']
    );
    assert.equal(operations[0][1].modelId, 'python-worker-model');
});

test('training schemas reject malformed rollouts and trajectories before worker execution', () => {
    assert.throws(
        () => schemas.validateRolloutRequest({ messages: [] }),
        /non-empty array/
    );
    assert.throws(
        () => schemas.validateRolloutResult({ samples: [{ content: 42 }] }),
        /content must be a string/
    );
    assert.throws(
        () => schemas.createTrainBatch([trajectory({ reward: Number.NaN })]),
        /reward must be finite/
    );
});
