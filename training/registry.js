const { validateModelAdapter, hasCapability } = require('./model-adapter');
const { validateAlgorithmAdapter } = require('./algorithm-adapter');
const {
    validateRolloutRequest,
    validateRolloutResult,
    createTrainBatch,
} = require('./schemas');
const { TrainingContractError, CapabilityMismatchError } = require('./errors');

class TrainingBinding {
    constructor(model, algorithm, config = {}) {
        this.model = model;
        this.algorithm = algorithm;
        this.config = config && typeof config === 'object' ? { ...config } : {};

        if (algorithm.validateConfig) {
            const result = algorithm.validateConfig(this.config, { model });
            if (result && typeof result.then === 'function') {
                throw new TrainingContractError(
                    `Algorithm "${algorithm.id}" validateConfig() must be synchronous`
                );
            }
        }
    }

    describe() {
        return {
            model: {
                id: this.model.id,
                capabilities: { ...this.model.capabilities },
                metadata: this.model.metadata || null,
            },
            algorithm: {
                id: this.algorithm.id,
                requirements: [...this.algorithm.requirements],
                metadata: this.algorithm.metadata || null,
            },
            config: { ...this.config },
        };
    }

    async generate(request) {
        if (!hasCapability(this.model, 'generate')) {
            throw new CapabilityMismatchError(this.model.id, 'rollout', ['generate']);
        }
        const validated = validateRolloutRequest(request);
        const sampling = validated.sampling || {};
        const requested = [];
        if ((sampling.numSamples || 1) > 1 && !hasCapability(this.model, 'multipleSamples')) {
            requested.push('multipleSamples');
        }
        if (sampling.returnTokenLogprobs && !hasCapability(this.model, 'tokenLogprobs')) {
            requested.push('tokenLogprobs');
        }
        if (requested.length > 0) {
            throw new CapabilityMismatchError(this.model.id, 'rollout', requested);
        }
        const result = await this.model.generate(validated, {
            algorithm: this.algorithm,
            config: this.config,
        });
        return validateRolloutResult(result);
    }

    async prepareBatch(trajectories) {
        const batch = createTrainBatch(trajectories, {
            modelId: this.model.id,
            algorithmId: this.algorithm.id,
            createdAt: new Date().toISOString(),
        });
        const prepared = await this.algorithm.prepareBatch(batch, {
            model: this.model,
            config: this.config,
        });
        if (prepared === undefined || prepared === null) {
            throw new TrainingContractError(
                `Algorithm "${this.algorithm.id}" prepareBatch() returned no batch`
            );
        }
        return prepared;
    }

    async train(trajectories) {
        const batch = await this.prepareBatch(trajectories);
        return await this.algorithm.train(batch, {
            model: this.model,
            config: this.config,
        });
    }
}

class TrainingRegistry {
    constructor(options = {}) {
        this.models = new Map();
        this.algorithms = new Map();
        for (const model of options.models || []) this.registerModel(model);
        for (const algorithm of options.algorithms || []) this.registerAlgorithm(algorithm);
    }

    registerModel(adapter) {
        const validated = Object.freeze(validateModelAdapter(adapter));
        if (this.models.has(validated.id)) {
            throw new TrainingContractError(`Duplicate training model: ${validated.id}`);
        }
        this.models.set(validated.id, validated);
        return validated;
    }

    registerAlgorithm(adapter) {
        const validated = Object.freeze(validateAlgorithmAdapter(adapter));
        if (this.algorithms.has(validated.id)) {
            throw new TrainingContractError(`Duplicate training algorithm: ${validated.id}`);
        }
        this.algorithms.set(validated.id, validated);
        return validated;
    }

    getModel(id) {
        return this.models.get(id) || null;
    }

    getAlgorithm(id) {
        return this.algorithms.get(id) || null;
    }

    listModels() {
        return [...this.models.values()].map((model) => ({
            id: model.id,
            capabilities: { ...model.capabilities },
            metadata: model.metadata || null,
        }));
    }

    listAlgorithms() {
        return [...this.algorithms.values()].map((algorithm) => ({
            id: algorithm.id,
            requirements: [...algorithm.requirements],
            metadata: algorithm.metadata || null,
        }));
    }

    compatibility(modelId, algorithmId) {
        const model = this.getModel(modelId);
        const algorithm = this.getAlgorithm(algorithmId);
        if (!model) throw new TrainingContractError(`Unknown training model: ${modelId}`);
        if (!algorithm) throw new TrainingContractError(`Unknown training algorithm: ${algorithmId}`);

        const missing = algorithm.requirements.filter(
            (capability) => !hasCapability(model, capability)
        );
        return {
            compatible: missing.length === 0,
            modelId,
            algorithmId,
            missing,
        };
    }

    bind(modelId, algorithmId, config = {}) {
        const compatibility = this.compatibility(modelId, algorithmId);
        if (!compatibility.compatible) {
            throw new CapabilityMismatchError(modelId, algorithmId, compatibility.missing);
        }
        return new TrainingBinding(
            this.getModel(modelId),
            this.getAlgorithm(algorithmId),
            config
        );
    }
}

module.exports = { TrainingRegistry, TrainingBinding };
