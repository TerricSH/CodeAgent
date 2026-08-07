const { normalizeSandboxConfig, ...shared } = require('../../sandbox/policy');

function normalizeConfig(config = {}) {
    return normalizeSandboxConfig(config);
}

module.exports = { ...shared, normalizeConfig };
