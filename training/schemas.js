const { TrainingContractError } = require('./errors');

const SCHEMA_VERSION = 1;
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TrainingContractError(`${label} must be an object`);
    }
    return value;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function validateMessage(message, index) {
    plainObject(message, `messages[${index}]`);
    if (!MESSAGE_ROLES.has(message.role)) {
        throw new TrainingContractError(`messages[${index}].role is invalid`);
    }
    if (message.content !== null && typeof message.content !== 'string') {
        throw new TrainingContractError(`messages[${index}].content must be a string or null`);
    }
    return message;
}

function validateRolloutRequest(request) {
    plainObject(request, 'RolloutRequest');
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
        throw new TrainingContractError('RolloutRequest.messages must be a non-empty array');
    }
    request.messages.forEach(validateMessage);

    if (request.sampling !== undefined) {
        plainObject(request.sampling, 'RolloutRequest.sampling');
        if (
            request.sampling.numSamples !== undefined
            && (!Number.isInteger(request.sampling.numSamples) || request.sampling.numSamples < 1)
        ) {
            throw new TrainingContractError('sampling.numSamples must be a positive integer');
        }
        if (
            request.sampling.returnTokenLogprobs !== undefined
            && typeof request.sampling.returnTokenLogprobs !== 'boolean'
        ) {
            throw new TrainingContractError('sampling.returnTokenLogprobs must be a boolean');
        }
    }
    return clone(request);
}

function validateRolloutResult(result) {
    plainObject(result, 'RolloutResult');
    if (!Array.isArray(result.samples) || result.samples.length === 0) {
        throw new TrainingContractError('RolloutResult.samples must be a non-empty array');
    }
    result.samples.forEach((sample, index) => {
        plainObject(sample, `samples[${index}]`);
        if (typeof sample.content !== 'string') {
            throw new TrainingContractError(`samples[${index}].content must be a string`);
        }
        if (sample.tokenLogprobs !== undefined && !Array.isArray(sample.tokenLogprobs)) {
            throw new TrainingContractError(`samples[${index}].tokenLogprobs must be an array`);
        }
    });
    return clone(result);
}

function validateRewardSignal(signal, index) {
    plainObject(signal, `rewards[${index}]`);
    if (!Number.isFinite(signal.value)) {
        throw new TrainingContractError(`rewards[${index}].value must be finite`);
    }
    return signal;
}

function validateTrajectory(trajectory, index = 0) {
    plainObject(trajectory, `trajectories[${index}]`);
    if (typeof trajectory.id !== 'string' || !trajectory.id) {
        throw new TrainingContractError(`trajectories[${index}].id must be a non-empty string`);
    }
    plainObject(trajectory.input, `trajectories[${index}].input`);
    if (!Array.isArray(trajectory.toolCalls)) {
        throw new TrainingContractError(`trajectories[${index}].toolCalls must be an array`);
    }
    if (!Array.isArray(trajectory.rewards)) {
        throw new TrainingContractError(`trajectories[${index}].rewards must be an array`);
    }
    trajectory.rewards.forEach(validateRewardSignal);
    if (!Number.isFinite(trajectory.reward)) {
        throw new TrainingContractError(`trajectories[${index}].reward must be finite`);
    }
    return trajectory;
}

function createTrainBatch(trajectories, metadata = {}) {
    if (!Array.isArray(trajectories) || trajectories.length === 0) {
        throw new TrainingContractError('Training requires at least one trajectory');
    }
    trajectories.forEach(validateTrajectory);
    plainObject(metadata, 'TrainBatch.metadata');
    return {
        version: SCHEMA_VERSION,
        trajectories: clone(trajectories),
        metadata: clone(metadata),
    };
}

function validateTrainBatch(batch) {
    plainObject(batch, 'TrainBatch');
    if (batch.version !== SCHEMA_VERSION) {
        throw new TrainingContractError(`Unsupported TrainBatch version: ${batch.version}`);
    }
    if (!Array.isArray(batch.trajectories) || batch.trajectories.length === 0) {
        throw new TrainingContractError('TrainBatch.trajectories must be a non-empty array');
    }
    batch.trajectories.forEach(validateTrajectory);
    plainObject(batch.metadata, 'TrainBatch.metadata');
    return clone(batch);
}

module.exports = {
    SCHEMA_VERSION,
    validateRolloutRequest,
    validateRolloutResult,
    validateTrajectory,
    createTrainBatch,
    validateTrainBatch,
};
