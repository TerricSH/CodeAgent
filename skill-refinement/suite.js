const fs = require('node:fs');
const path = require('node:path');

const SUITE_VERSION = 1;
const DEFAULT_PROTECTED_PATHS = Object.freeze([
    'test',
    '.github',
    'prompts',
    'skills/core-development',
    'skill-refinement',
    'tools/skill-refinement',
    'plugins/docker-sandbox',
    'package.json',
    'package-lock.json',
]);

function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function positiveManifestInteger(value, fallback, label) {
    if (value === undefined || value === null) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return number;
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
        throw new Error(`${label} escapes the Skill Refinement project`);
    }
    return normalized;
}

function normalizeModelRef(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 500) {
        throw new Error(`${label} must be a model reference with at most 500 characters`);
    }
    const ref = value.trim();
    if (!/^[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?(?:\/[^\s\x00-\x1f]+)?$/.test(ref)) {
        throw new Error(`${label} must use vendor[@interface][/model] syntax`);
    }
    return ref;
}

function loadSuite(suitesRoot, suiteId, projectRoot) {
    if (typeof suiteId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(suiteId)) {
        throw new Error('suiteId is invalid');
    }
    if (!fs.existsSync(suitesRoot)) {
        throw new Error(`Skill Refinement suite root does not exist: ${suitesRoot}`);
    }
    const suiteDir = path.join(suitesRoot, suiteId);
    const manifestPath = path.join(suiteDir, 'suite.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Unknown Skill Refinement suite: ${suiteId}`);
    assertInside(suitesRoot, suiteDir, 'Skill Refinement suite');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Skill Refinement suite manifest must be an object');
    }
    if (manifest.schemaVersion !== SUITE_VERSION) {
        throw new Error(`Unsupported Skill Refinement suite schemaVersion: ${manifest.schemaVersion}`);
    }
    if (manifest.id !== suiteId) {
        throw new Error('Skill Refinement suite id must match its directory name');
    }
    if (typeof manifest.task !== 'string' || !manifest.task.trim()) {
        throw new Error('Skill Refinement suite task is required');
    }
    if (manifest.task.length > 16000) {
        throw new Error('Skill Refinement suite task exceeds 16000 characters');
    }
    if (!manifest.evaluation || typeof manifest.evaluation !== 'object') {
        throw new Error('Skill Refinement suite evaluation configuration is required');
    }
    const evaluationCommand = typeof manifest.evaluation.command === 'string'
        ? manifest.evaluation.command.trim()
        : '';
    if (!evaluationCommand) {
        throw new Error('Skill Refinement suite evaluation.command is required');
    }
    if (evaluationCommand.length > 32768) {
        throw new Error('Skill Refinement suite evaluation.command exceeds 32768 characters');
    }

    const baselineRelative = manifest.baseline === undefined
        ? '.'
        : normalizeRelative(manifest.baseline, 'baseline');
    const baseline = assertInside(
        projectRoot,
        path.resolve(projectRoot, baselineRelative),
        'Skill Refinement baseline'
    );
    const protectedPaths = (manifest.protectedPaths || DEFAULT_PROTECTED_PATHS)
        .map((item, index) => normalizeRelative(item, `protectedPaths[${index}]`));

    if (manifest.skillPath === undefined) {
        throw new Error('Skill Refinement suite skillPath is required');
    }
    const skillRelative = normalizeRelative(manifest.skillPath, 'skillPath');
    const skillPath = assertInside(
        suiteDir,
        path.resolve(suiteDir, skillRelative),
        'Skill seed'
    );
    if (!fs.statSync(skillPath).isFile()) throw new Error('skillPath must point to a file');
    const skill = fs.readFileSync(skillPath, 'utf8');
    if (!skill.trim()) throw new Error('Skill seed must not be empty');
    if (skill.length > 64000) throw new Error('Skill seed exceeds 64000 characters');

    return Object.freeze({
        schemaVersion: SUITE_VERSION,
        id: suiteId,
        task: manifest.task.trim(),
        baseline,
        suiteDir: fs.realpathSync(suiteDir),
        skill,
        skillPath,
        templateModel: normalizeModelRef(manifest.templateModel, 'templateModel'),
        reflectionModel: normalizeModelRef(manifest.reflectionModel, 'reflectionModel'),
        rollouts: boundedInteger(manifest.rollouts, 4, 2, 8),
        epochs: positiveManifestInteger(manifest.epochs, 1, 'epochs'),
        stepsPerEpoch: positiveManifestInteger(
            manifest.stepsPerEpoch,
            1,
            'stepsPerEpoch'
        ),
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
        .filter(entry => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (!fs.existsSync(path.join(suitesRoot, entry.name, 'suite.json'))) continue;
        try {
            const suite = loadSuite(suitesRoot, entry.name, projectRoot);
            suites.push({
                id: suite.id,
                task: suite.task,
                rollouts: suite.rollouts,
                epochs: suite.epochs,
                stepsPerEpoch: suite.stepsPerEpoch,
                evaluationCommand: suite.evaluation.command,
                protectedPaths: [...suite.protectedPaths],
                skillPath: suite.skillPath,
                templateModel: suite.templateModel,
                reflectionModel: suite.reflectionModel,
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
    normalizeModelRef,
    positiveManifestInteger,
};
