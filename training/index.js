const { TrainingRegistry, TrainingBinding } = require('./registry');
const {
    STANDARD_CAPABILITIES,
    defineModelAdapter,
    validateModelAdapter,
    hasCapability,
} = require('./model-adapter');
const {
    TYPICAL_REQUIREMENTS,
    defineAlgorithmAdapter,
    validateAlgorithmAdapter,
} = require('./algorithm-adapter');
const { createWorkerModelAdapter } = require('./worker-model-adapter');
const JsonlWorkerClient = require('./jsonl-worker-client');
const { ModelPackageManager } = require('./package-manager');
const modelPackage = require('./model-package');
const schemas = require('./schemas');
const errors = require('./errors');

module.exports = {
    TrainingRegistry,
    TrainingBinding,
    STANDARD_CAPABILITIES,
    TYPICAL_REQUIREMENTS,
    defineModelAdapter,
    validateModelAdapter,
    hasCapability,
    defineAlgorithmAdapter,
    validateAlgorithmAdapter,
    createWorkerModelAdapter,
    JsonlWorkerClient,
    ModelPackageManager,
    modelPackage,
    schemas,
    ...errors,
};
