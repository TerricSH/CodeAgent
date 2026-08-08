const path = require('node:path');
const { normalizeSandboxConfig, positiveInteger } = require('../sandbox/policy');

function normalizeRefinementConfig(config = {}) {
    const sandbox = normalizeSandboxConfig(config);
    const projectRoot = path.resolve(config.projectRoot || process.cwd());
    return Object.freeze({
        ...sandbox,
        projectRoot,
        suitesRoot: path.resolve(
            config.suitesRoot || path.join(projectRoot, 'skill-refinement', 'suites')
        ),
        maxRuns: positiveInteger(config.maxRuns, 20),
    });
}

module.exports = { normalizeRefinementConfig };
