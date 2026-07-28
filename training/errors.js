class TrainingContractError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'TrainingContractError';
        this.details = details;
    }
}

class CapabilityMismatchError extends TrainingContractError {
    constructor(modelId, algorithmId, missing) {
        super(
            `Model "${modelId}" cannot run algorithm "${algorithmId}"; missing capabilities: ${missing.join(', ')}`,
            { modelId, algorithmId, missing }
        );
        this.name = 'CapabilityMismatchError';
        this.modelId = modelId;
        this.algorithmId = algorithmId;
        this.missing = missing;
    }
}

module.exports = { TrainingContractError, CapabilityMismatchError };
