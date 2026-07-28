const { defineModelAdapter, normalizeCapabilities } = require('./model-adapter');
const { TrainingContractError } = require('./errors');

const OPERATION_BY_METHOD = Object.freeze({
    generate: 'generate',
    tokenize: 'tokenize',
    computeLogprobs: 'compute_logprobs',
    computeReferenceLogprobs: 'compute_reference_logprobs',
    computeValues: 'compute_values',
    trainStep: 'train_step',
    saveCheckpoint: 'save_checkpoint',
    loadCheckpoint: 'load_checkpoint',
});

function createWorkerModelAdapter(options = {}) {
    if (!options.worker || typeof options.worker.request !== 'function') {
        throw new TrainingContractError('Worker model adapter requires worker.request(operation, payload)');
    }
    const capabilities = normalizeCapabilities(options.capabilities || {});
    const adapter = {
        id: options.id,
        capabilities,
        metadata: options.metadata || null,
    };

    const invoke = (method) => async (payload, context = {}) => {
        return await options.worker.request(OPERATION_BY_METHOD[method], {
            modelId: options.id,
            payload,
            context: {
                algorithmId: context.algorithm ? context.algorithm.id : null,
                config: context.config || null,
            },
        });
    };

    if (capabilities.generate) adapter.generate = invoke('generate');
    if (capabilities.tokenize) adapter.tokenize = invoke('tokenize');
    if (capabilities.tokenLogprobs) adapter.computeLogprobs = invoke('computeLogprobs');
    if (capabilities.referencePolicy) {
        adapter.computeReferenceLogprobs = invoke('computeReferenceLogprobs');
    }
    if (capabilities.valueModel) adapter.computeValues = invoke('computeValues');
    if (capabilities.trainable) adapter.trainStep = invoke('trainStep');
    if (capabilities.checkpoint) {
        adapter.saveCheckpoint = invoke('saveCheckpoint');
        adapter.loadCheckpoint = invoke('loadCheckpoint');
    }

    return defineModelAdapter(adapter);
}

module.exports = { createWorkerModelAdapter, OPERATION_BY_METHOD };
