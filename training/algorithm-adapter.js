const { TrainingContractError } = require('./errors');

const TYPICAL_REQUIREMENTS = Object.freeze({
    sft: Object.freeze(['tokenize', 'trainable', 'checkpoint']),
    dpo: Object.freeze(['tokenize', 'tokenLogprobs', 'referencePolicy', 'trainable', 'checkpoint']),
    grpo: Object.freeze([
        'generate',
        'multipleSamples',
        'tokenize',
        'tokenLogprobs',
        'referencePolicy',
        'trainable',
        'checkpoint',
    ]),
    ppo: Object.freeze([
        'generate',
        'tokenize',
        'tokenLogprobs',
        'referencePolicy',
        'valueModel',
        'trainable',
        'checkpoint',
    ]),
});

function normalizeRequirements(requirements) {
    if (!Array.isArray(requirements)) {
        throw new TrainingContractError('Algorithm adapter must provide a requirements array');
    }
    const normalized = requirements.map((item) => {
        if (typeof item !== 'string' || !item.trim()) {
            throw new TrainingContractError('Algorithm requirements must be non-empty strings');
        }
        return item.trim();
    });
    return Object.freeze([...new Set(normalized)]);
}

function validateAlgorithmAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
        throw new TrainingContractError('Algorithm adapter must be an object');
    }
    if (typeof adapter.id !== 'string' || !adapter.id.trim()) {
        throw new TrainingContractError('Algorithm adapter must provide a non-empty id');
    }
    if (typeof adapter.prepareBatch !== 'function') {
        throw new TrainingContractError(`Algorithm "${adapter.id}" must implement prepareBatch()`);
    }
    if (typeof adapter.train !== 'function') {
        throw new TrainingContractError(`Algorithm "${adapter.id}" must implement train()`);
    }
    if (adapter.validateConfig !== undefined && typeof adapter.validateConfig !== 'function') {
        throw new TrainingContractError(`Algorithm "${adapter.id}" validateConfig must be a function`);
    }

    return {
        ...adapter,
        id: adapter.id.trim(),
        requirements: normalizeRequirements(adapter.requirements),
    };
}

function defineAlgorithmAdapter(adapter) {
    return Object.freeze(validateAlgorithmAdapter(adapter));
}

module.exports = {
    TYPICAL_REQUIREMENTS,
    normalizeRequirements,
    validateAlgorithmAdapter,
    defineAlgorithmAdapter,
};
