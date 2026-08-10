const VerifierRegistry = require('./registry');
const { VerificationEngine, STATUSES } = require('./engine');
const { createPlan, deepFreeze, stableValue, CHECK_TYPES } = require('./plan');
const commandProvider = require('./providers/command');
const fileProvider = require('./providers/file');
const jsonProvider = require('./providers/json');

function createDefaultVerifierRegistry(extraProviders = []) {
    return new VerifierRegistry([commandProvider, fileProvider, jsonProvider, ...extraProviders]);
}

module.exports = {
    VerifierRegistry,
    VerificationEngine,
    createPlan,
    createDefaultVerifierRegistry,
    commandProvider,
    fileProvider,
    jsonProvider,
    deepFreeze,
    stableValue,
    CHECK_TYPES,
    STATUSES,
};
