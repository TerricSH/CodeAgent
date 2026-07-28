const { TrainingContractError } = require('./errors');

const STANDARD_CAPABILITIES = Object.freeze([
    'generate',
    'multipleSamples',
    'tokenize',
    'tokenLogprobs',
    'referencePolicy',
    'valueModel',
    'trainable',
    'checkpoint',
]);

const METHODS_BY_CAPABILITY = Object.freeze({
    generate: ['generate'],
    tokenize: ['tokenize'],
    tokenLogprobs: ['computeLogprobs'],
    referencePolicy: ['computeReferenceLogprobs'],
    valueModel: ['computeValues'],
    trainable: ['trainStep'],
    checkpoint: ['saveCheckpoint', 'loadCheckpoint'],
});

function normalizeCapabilities(capabilities) {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        throw new TrainingContractError('Model adapter must provide a capabilities object');
    }

    const normalized = {};
    for (const name of STANDARD_CAPABILITIES) normalized[name] = false;
    for (const [name, enabled] of Object.entries(capabilities)) {
        if (typeof enabled !== 'boolean') {
            throw new TrainingContractError(`Capability "${name}" must be a boolean`);
        }
        normalized[name] = enabled;
    }
    if (normalized.multipleSamples && !normalized.generate) {
        throw new TrainingContractError('Capability "multipleSamples" requires "generate"');
    }
    return Object.freeze(normalized);
}

function validateModelAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
        throw new TrainingContractError('Model adapter must be an object');
    }
    if (typeof adapter.id !== 'string' || !adapter.id.trim()) {
        throw new TrainingContractError('Model adapter must provide a non-empty id');
    }

    const capabilities = normalizeCapabilities(adapter.capabilities);
    for (const [capability, methods] of Object.entries(METHODS_BY_CAPABILITY)) {
        if (!capabilities[capability]) continue;
        for (const method of methods) {
            if (typeof adapter[method] !== 'function') {
                throw new TrainingContractError(
                    `Model "${adapter.id}" enables "${capability}" but does not implement ${method}()`,
                    { modelId: adapter.id, capability, method }
                );
            }
        }
    }
    return { ...adapter, id: adapter.id.trim(), capabilities };
}

function defineModelAdapter(adapter) {
    return Object.freeze(validateModelAdapter(adapter));
}

function hasCapability(adapter, capability) {
    return Boolean(adapter && adapter.capabilities && adapter.capabilities[capability]);
}

module.exports = {
    STANDARD_CAPABILITIES,
    METHODS_BY_CAPABILITY,
    normalizeCapabilities,
    validateModelAdapter,
    defineModelAdapter,
    hasCapability,
};
