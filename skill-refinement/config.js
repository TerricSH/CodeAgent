const path = require('node:path');
const { normalizeSandboxConfig, positiveInteger } = require('../sandbox/policy');

function normalizeRefinementConfig(config = {}) {
    const sandbox = normalizeSandboxConfig(config);
    const projectRoot = path.resolve(config.projectRoot || process.cwd());
    const requestedBackend = String(
        config.refinementBackend
        || process.env.CODEAGENT_REFINEMENT_SANDBOX
        || 'docker'
    ).toLowerCase();
    if (requestedBackend !== 'docker') {
        throw new Error('Skill Refinement requires the local Docker backend');
    }
    return Object.freeze({
        ...sandbox,
        projectRoot,
        refinementBackend: 'docker',
        suitesRoot: path.resolve(
            config.suitesRoot || path.join(projectRoot, 'skill-refinement', 'suites')
        ),
        maxRuns: positiveInteger(config.maxRuns, 20),
        modelTransportAttempts: positiveInteger(config.modelTransportAttempts, 3),
        modelRetryDelayMs: Number.isFinite(Number(config.modelRetryDelayMs))
            ? Math.max(0, Number(config.modelRetryDelayMs))
            : 250,
        modelRequestTimeoutMs: positiveInteger(config.modelRequestTimeoutMs, 120000),
    });
}

module.exports = { normalizeRefinementConfig };
