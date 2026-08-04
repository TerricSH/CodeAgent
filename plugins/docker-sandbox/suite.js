const fs = require('fs');
const path = require('path');

const SUITE_VERSION = 1;
const DEFAULT_PROTECTED_PATHS = Object.freeze([
    'test',
    '.github',
    'prompts',
    'skills/core-development',
    'plugins/docker-sandbox',
    'plugins/reward-evaluator',
    'package.json',
    'package-lock.json',
]);

function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function assertInside(root, candidate, label) {
    const base = fs.realpathSync(path.resolve(root));
    const resolved = fs.realpathSync(path.resolve(candidate));
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
        throw new Error(`${label} resolves outside its allowed root`);
    }
    return resolved;
}

function normalizeRelative(value, label) {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
        throw new Error(`${label} must be a non-empty relative path`);
    }
    const normalized = path.normalize(value.trim());
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new Error(`${label} escapes the training project`);
    }
    return normalized;
}

function loadSuite(suitesRoot, suiteId, projectRoot) {
    if (typeof suiteId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(suiteId)) {
        throw new Error('suiteId is invalid');
    }
    if (!fs.existsSync(suitesRoot)) throw new Error(`Training suite root does not exist: ${suitesRoot}`);
    const suiteDir = path.join(suitesRoot, suiteId);
    const manifestPath = path.join(suiteDir, 'suite.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Unknown training suite: ${suiteId}`);
    assertInside(suitesRoot, suiteDir, 'Training suite');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Training suite manifest must be an object');
    }
    if (manifest.schemaVersion !== SUITE_VERSION) {
        throw new Error(`Unsupported training suite schemaVersion: ${manifest.schemaVersion}`);
    }
    if (manifest.id !== suiteId) throw new Error('Training suite id must match its directory name');
    if (typeof manifest.task !== 'string' || !manifest.task.trim()) {
        throw new Error('Training suite task is required');
    }
    if (manifest.task.length > 16000) throw new Error('Training suite task exceeds 16000 characters');
    if (!manifest.evaluation || typeof manifest.evaluation !== 'object') {
        throw new Error('Training suite evaluation configuration is required');
    }
    const evaluationCommand = typeof manifest.evaluation.command === 'string'
        ? manifest.evaluation.command.trim()
        : '';
    if (!evaluationCommand) throw new Error('Training suite evaluation.command is required');
    if (evaluationCommand.length > 32768) {
        throw new Error('Training suite evaluation.command exceeds 32768 characters');
    }

    const baselineRelative = manifest.baseline === undefined
        ? '.'
        : normalizeRelative(manifest.baseline, 'baseline');
    const baseline = assertInside(projectRoot, path.resolve(projectRoot, baselineRelative), 'Baseline');
    const protectedPaths = (manifest.protectedPaths || DEFAULT_PROTECTED_PATHS)
        .map((item, index) => normalizeRelative(item, `protectedPaths[${index}]`));

    let skill = '';
    let skillPath = null;
    if (manifest.skillPath !== undefined) {
        const relative = normalizeRelative(manifest.skillPath, 'skillPath');
        skillPath = assertInside(suiteDir, path.resolve(suiteDir, relative), 'Skill seed');
        if (!fs.statSync(skillPath).isFile()) throw new Error('skillPath must point to a file');
        skill = fs.readFileSync(skillPath, 'utf8');
        if (skill.length > 32000) throw new Error('Skill seed exceeds 32000 characters');
    }

    return Object.freeze({
        schemaVersion: SUITE_VERSION,
        id: suiteId,
        task: manifest.task.trim(),
        baseline,
        suiteDir: fs.realpathSync(suiteDir),
        skill,
        skillPath,
        rollouts: boundedInteger(manifest.rollouts, 4, 2, 8),
        evaluation: Object.freeze({
            command: evaluationCommand,
            timeoutMs: boundedInteger(manifest.evaluation.timeoutMs, 120000, 1000, 120000),
        }),
        protectedPaths: Object.freeze(protectedPaths),
    });
}

function listSuites(suitesRoot, projectRoot) {
    if (!fs.existsSync(suitesRoot)) return { root: suitesRoot, suites: [], errors: [] };
    const suites = [];
    const errors = [];
    const entries = fs.readdirSync(suitesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (!fs.existsSync(path.join(suitesRoot, entry.name, 'suite.json'))) continue;
        try {
            const suite = loadSuite(suitesRoot, entry.name, projectRoot);
            suites.push({
                id: suite.id,
                task: suite.task,
                rollouts: suite.rollouts,
                evaluationCommand: suite.evaluation.command,
                protectedPaths: [...suite.protectedPaths],
                skillPath: suite.skillPath,
            });
        } catch (error) {
            errors.push({ directory: entry.name, error: error.message });
        }
    }
    return { root: suitesRoot, suites, errors };
}

module.exports = {
    SUITE_VERSION,
    DEFAULT_PROTECTED_PATHS,
    loadSuite,
    listSuites,
    normalizeRelative,
};
