const fs = require('node:fs');
const path = require('node:path');

const SUITE_VERSION = 2;
const DATA_SPLITS = Object.freeze(['train', 'selection', 'test']);
const EDIT_BUDGET_SCHEDULES = new Set(['constant', 'linear', 'cosine', 'autonomous']);
const REWARD_MODES = new Set(['exit_code', 'stdout_json']);
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

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function assertKnownKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
        throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function normalizeReward(value = {}, label = 'evaluation.reward') {
    const reward = value == null ? {} : plainObject(value, label);
    assertKnownKeys(
        reward,
        new Set(['mode', 'field', 'successField', 'successThreshold']),
        label
    );
    const mode = reward.mode || 'exit_code';
    if (!REWARD_MODES.has(mode)) {
        throw new Error(`${label}.mode must be exit_code or stdout_json`);
    }
    const field = reward.field === undefined ? 'reward' : String(reward.field).trim();
    if (mode === 'stdout_json' && !field) {
        throw new Error(`${label}.field is required for stdout_json rewards`);
    }
    const successField = reward.successField === undefined
        ? 'success'
        : String(reward.successField).trim();
    const successThreshold = reward.successThreshold === undefined
        ? 1
        : Number(reward.successThreshold);
    if (!Number.isFinite(successThreshold) || successThreshold < 0 || successThreshold > 1) {
        throw new Error(`${label}.successThreshold must be within [0, 1]`);
    }
    return Object.freeze({ mode, field, successField, successThreshold });
}

function normalizeEvaluation(value, fallback = null, label = 'evaluation') {
    const evaluation = value == null ? {} : plainObject(value, label);
    assertKnownKeys(evaluation, new Set(['command', 'timeoutMs', 'reward']), label);
    const command = typeof evaluation.command === 'string'
        ? evaluation.command.trim()
        : (fallback?.command || '');
    if (!command) throw new Error(`${label}.command is required`);
    if (command.length > 32768) throw new Error(`${label}.command exceeds 32768 characters`);
    const timeoutMs = boundedInteger(
        evaluation.timeoutMs,
        fallback?.timeoutMs || 120000,
        1000,
        120000
    );
    const reward = normalizeReward(evaluation.reward || fallback?.reward || {}, `${label}.reward`);
    return Object.freeze({ command, timeoutMs, reward });
}

function readDatasetSource(source, suiteDir, label) {
    if (Array.isArray(source)) return source;
    const config = plainObject(source, label);
    assertKnownKeys(config, new Set(['file']), label);
    const relative = normalizeRelative(config.file, `${label}.file`);
    const file = assertInside(suiteDir, path.resolve(suiteDir, relative), label);
    const text = fs.readFileSync(file, 'utf8');
    if (file.toLowerCase().endsWith('.jsonl')) {
        return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
            try {
                return JSON.parse(line);
            } catch (error) {
                throw new Error(`${label}.file line ${index + 1} is invalid JSON: ${error.message}`);
            }
        });
    }
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        assertKnownKeys(parsed, new Set(['items']), `${label}.file`);
        if (Array.isArray(parsed.items)) return parsed.items;
    }
    throw new Error(`${label}.file must contain an array or {"items": [...]}`);
}

function normalizeDatasetItem(value, split, index, globalEvaluation) {
    const label = `dataset.${split}[${index}]`;
    const item = plainObject(value, label);
    assertKnownKeys(item, new Set(['id', 'task', 'metadata', 'evaluation']), label);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
        throw new Error(`${label}.id is invalid`);
    }
    const task = typeof item.task === 'string' ? item.task.trim() : '';
    if (!task) throw new Error(`${label}.task is required`);
    if (task.length > 16000) throw new Error(`${label}.task exceeds 16000 characters`);
    const metadata = item.metadata === undefined
        ? Object.freeze({})
        : deepFreeze(plainObject(item.metadata, `${label}.metadata`));
    const evaluation = item.evaluation === undefined
        ? globalEvaluation
        : normalizeEvaluation(item.evaluation, globalEvaluation, `${label}.evaluation`);
    return Object.freeze({ id, split, task, metadata, evaluation });
}

function normalizeDataset(value, suiteDir, globalEvaluation) {
    const dataset = plainObject(value, 'dataset');
    assertKnownKeys(dataset, new Set(DATA_SPLITS), 'dataset');
    const ids = new Set();
    const normalized = {};
    for (const split of DATA_SPLITS) {
        if (dataset[split] === undefined) throw new Error(`dataset.${split} is required`);
        const items = readDatasetSource(dataset[split], suiteDir, `dataset.${split}`)
            .map((item, index) => normalizeDatasetItem(item, split, index, globalEvaluation));
        if (items.length === 0) throw new Error(`dataset.${split} must not be empty`);
        for (const item of items) {
            if (ids.has(item.id)) {
                throw new Error(`Dataset item id must be unique across splits: ${item.id}`);
            }
            ids.add(item.id);
        }
        normalized[split] = Object.freeze(items);
    }
    return Object.freeze(normalized);
}

function normalizeOptimizer(value = {}) {
    const optimizer = value == null ? {} : plainObject(value, 'optimizer');
    assertKnownKeys(optimizer, new Set([
        'epochs',
        'rolloutBatchSize',
        'accumulationFactor',
        'reflectionMinibatchSize',
        'mergeBatchSize',
        'analystWorkers',
        'reflectionRounds',
        'shuffleSeed',
        'editBudget',
        'rejectedBuffer',
        'slowUpdate',
        'metaUpdate',
    ]), 'optimizer');
    const editBudgetValue = optimizer.editBudget == null
        ? {}
        : plainObject(optimizer.editBudget, 'optimizer.editBudget');
    assertKnownKeys(
        editBudgetValue,
        new Set(['initial', 'floor', 'schedule']),
        'optimizer.editBudget'
    );
    const initial = positiveManifestInteger(
        editBudgetValue.initial,
        4,
        'optimizer.editBudget.initial'
    );
    const floor = positiveManifestInteger(
        editBudgetValue.floor,
        2,
        'optimizer.editBudget.floor'
    );
    if (floor > initial) {
        throw new Error('optimizer.editBudget.floor must not exceed initial');
    }
    const schedule = editBudgetValue.schedule || 'cosine';
    if (!EDIT_BUDGET_SCHEDULES.has(schedule)) {
        throw new Error('optimizer.editBudget.schedule is invalid');
    }
    const rejectedValue = optimizer.rejectedBuffer == null
        ? {}
        : plainObject(optimizer.rejectedBuffer, 'optimizer.rejectedBuffer');
    assertKnownKeys(
        rejectedValue,
        new Set(['enabled', 'maxEntries']),
        'optimizer.rejectedBuffer'
    );
    const slowValue = optimizer.slowUpdate == null
        ? {}
        : plainObject(optimizer.slowUpdate, 'optimizer.slowUpdate');
    assertKnownKeys(
        slowValue,
        new Set(['enabled', 'sampleSize']),
        'optimizer.slowUpdate'
    );
    const metaValue = optimizer.metaUpdate == null
        ? {}
        : plainObject(optimizer.metaUpdate, 'optimizer.metaUpdate');
    assertKnownKeys(metaValue, new Set(['enabled']), 'optimizer.metaUpdate');
    return Object.freeze({
        epochs: positiveManifestInteger(optimizer.epochs, 4, 'optimizer.epochs'),
        rolloutBatchSize: positiveManifestInteger(
            optimizer.rolloutBatchSize,
            40,
            'optimizer.rolloutBatchSize'
        ),
        accumulationFactor: positiveManifestInteger(
            optimizer.accumulationFactor,
            1,
            'optimizer.accumulationFactor'
        ),
        reflectionMinibatchSize: positiveManifestInteger(
            optimizer.reflectionMinibatchSize,
            8,
            'optimizer.reflectionMinibatchSize'
        ),
        mergeBatchSize: positiveManifestInteger(
            optimizer.mergeBatchSize,
            8,
            'optimizer.mergeBatchSize'
        ),
        analystWorkers: boundedInteger(optimizer.analystWorkers, 16, 1, 64),
        reflectionRounds: boundedInteger(optimizer.reflectionRounds, 3, 1, 3),
        shuffleSeed: Number.isInteger(Number(optimizer.shuffleSeed))
            ? Number(optimizer.shuffleSeed)
            : 42,
        editBudget: Object.freeze({ initial, floor, schedule }),
        rejectedBuffer: Object.freeze({
            enabled: rejectedValue.enabled !== false,
            maxEntries: positiveManifestInteger(
                rejectedValue.maxEntries,
                20,
                'optimizer.rejectedBuffer.maxEntries'
            ),
        }),
        slowUpdate: Object.freeze({
            enabled: slowValue.enabled !== false,
            sampleSize: positiveManifestInteger(
                slowValue.sampleSize,
                20,
                'optimizer.slowUpdate.sampleSize'
            ),
        }),
        metaUpdate: Object.freeze({ enabled: metaValue.enabled !== false }),
    });
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
    plainObject(manifest, 'Skill Refinement suite manifest');
    if (manifest.schemaVersion !== SUITE_VERSION) {
        throw new Error(
            `Unsupported Skill Refinement suite schemaVersion: ${manifest.schemaVersion}; expected ${SUITE_VERSION}`
        );
    }
    assertKnownKeys(manifest, new Set([
        'schemaVersion',
        'id',
        'baseline',
        'skillPath',
        'templateModel',
        'reflectionModel',
        'dataset',
        'optimizer',
        'protectedPaths',
        'evaluation',
    ]), 'Skill Refinement suite manifest');
    if (manifest.id !== suiteId) {
        throw new Error('Skill Refinement suite id must match its directory name');
    }

    const globalEvaluation = normalizeEvaluation(manifest.evaluation);
    if (manifest.baseline === undefined) {
        throw new Error('Skill Refinement suite baseline is required');
    }
    const baselineRelative = normalizeRelative(manifest.baseline, 'baseline');
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

    const realSuiteDir = fs.realpathSync(suiteDir);
    if (baseline === realSuiteDir || baseline.startsWith(`${realSuiteDir}${path.sep}`)) {
        throw new Error('Skill Refinement baseline must not be inside its private suite directory');
    }
    const dataset = normalizeDataset(manifest.dataset, realSuiteDir, globalEvaluation);
    const optimizer = normalizeOptimizer(manifest.optimizer);
    return Object.freeze({
        schemaVersion: SUITE_VERSION,
        id: suiteId,
        baseline,
        suiteDir: realSuiteDir,
        skill,
        skillPath,
        templateModel: normalizeModelRef(manifest.templateModel, 'templateModel'),
        reflectionModel: normalizeModelRef(manifest.reflectionModel, 'reflectionModel'),
        dataset,
        optimizer,
        evaluation: globalEvaluation,
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
                dataset: Object.fromEntries(
                    DATA_SPLITS.map(split => [split, suite.dataset[split].length])
                ),
                optimizer: suite.optimizer,
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
    loadSuite,
    listSuites,
};
