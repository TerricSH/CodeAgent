const fs = require('fs');
const path = require('path');
const { createWorkerModelAdapter } = require('./worker-model-adapter');
const { defineAlgorithmAdapter } = require('./algorithm-adapter');
const { TrainingContractError } = require('./errors');
const JsonlWorkerClient = require('./jsonl-worker-client');

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const REQUIRED_ARTIFACTS = ['checkpoint', 'tokenizer', 'chatTemplate'];

function resolveInside(root, relative, label) {
    if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) {
        throw new TrainingContractError(`${label} must be a relative package path`);
    }
    const base = path.resolve(root);
    const resolved = path.resolve(base, relative);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
        throw new TrainingContractError(`${label} escapes the model package`);
    }
    if (!fs.existsSync(resolved)) {
        throw new TrainingContractError(`${label} does not exist: ${relative}`);
    }
    const realBase = fs.realpathSync(base);
    const realResolved = fs.realpathSync(resolved);
    if (realResolved !== realBase && !realResolved.startsWith(`${realBase}${path.sep}`)) {
        throw new TrainingContractError(`${label} resolves outside the model package`);
    }
    return realResolved;
}

function validateManifest(manifest, packageDir) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new TrainingContractError('Model package manifest must be an object');
    }
    if (manifest.schemaVersion !== MANIFEST_VERSION) {
        throw new TrainingContractError(
            `Unsupported model package schemaVersion: ${manifest.schemaVersion}`
        );
    }
    if (typeof manifest.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.id)) {
        throw new TrainingContractError('Model package id is invalid');
    }
    if (!manifest.artifacts || typeof manifest.artifacts !== 'object') {
        throw new TrainingContractError(`Model package "${manifest.id}" must declare artifacts`);
    }

    const resolvedArtifacts = {};
    for (const name of REQUIRED_ARTIFACTS) {
        resolvedArtifacts[name] = resolveInside(
            packageDir,
            manifest.artifacts[name],
            `artifacts.${name}`
        );
    }

    if (!manifest.worker || typeof manifest.worker !== 'object') {
        throw new TrainingContractError(`Model package "${manifest.id}" must declare worker`);
    }
    if (typeof manifest.worker.command !== 'string' || !manifest.worker.command.trim()) {
        throw new TrainingContractError(`Model package "${manifest.id}" worker.command is required`);
    }
    resolveInside(packageDir, manifest.worker.entry, 'worker.entry');
    if (
        manifest.worker.args !== undefined
        && (!Array.isArray(manifest.worker.args)
            || manifest.worker.args.some((item) => typeof item !== 'string'))
    ) {
        throw new TrainingContractError(`Model package "${manifest.id}" worker.args must be strings`);
    }
    if (!Array.isArray(manifest.algorithms) || manifest.algorithms.length === 0) {
        throw new TrainingContractError(`Model package "${manifest.id}" must declare algorithms`);
    }

    const algorithmIds = new Set();
    let defaultCount = 0;
    for (const algorithm of manifest.algorithms) {
        if (
            !algorithm
            || typeof algorithm.id !== 'string'
            || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(algorithm.id)
        ) {
            throw new TrainingContractError(`Model package "${manifest.id}" has an invalid algorithm id`);
        }
        if (algorithmIds.has(algorithm.id)) {
            throw new TrainingContractError(
                `Model package "${manifest.id}" has duplicate algorithm "${algorithm.id}"`
            );
        }
        algorithmIds.add(algorithm.id);
        if (!Array.isArray(algorithm.requirements) || !algorithm.requirements.includes('trainable')) {
            throw new TrainingContractError(
                `Algorithm "${algorithm.id}" must require the "trainable" capability`
            );
        }
        if (algorithm.default === true) defaultCount += 1;
    }
    if (defaultCount > 1) {
        throw new TrainingContractError(`Model package "${manifest.id}" has multiple default algorithms`);
    }

    return {
        ...manifest,
        packageDir: path.resolve(packageDir),
        resolvedArtifacts,
    };
}

function resolveWorkerCommand(packageDir, command) {
    if (command.startsWith('.') || command.includes('/') || command.includes('\\')) {
        return resolveInside(packageDir, command, 'worker.command');
    }
    return command;
}

function createPackageAlgorithm(modelId, descriptor) {
    const id = `${modelId}/${descriptor.id}`;
    const requiredConfig = descriptor.config && Array.isArray(descriptor.config.required)
        ? descriptor.config.required
        : [];
    return defineAlgorithmAdapter({
        id,
        requirements: descriptor.requirements,
        metadata: {
            packageId: modelId,
            localId: descriptor.id,
            displayName: descriptor.displayName || descriptor.id,
        },
        validateConfig(config) {
            const missing = requiredConfig.filter(
                (name) => !Object.prototype.hasOwnProperty.call(config, name)
            );
            if (missing.length > 0) {
                throw new TrainingContractError(
                    `Algorithm "${id}" is missing config: ${missing.join(', ')}`
                );
            }
        },
        prepareBatch(batch, { config }) {
            return {
                algorithmId: descriptor.id,
                config,
                batch,
            };
        },
        async train(prepared, { model }) {
            return await model.trainStep(prepared);
        },
    });
}

function loadModelPackage(packageDir, dependencies = {}) {
    const manifestPath = path.join(packageDir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
        throw new TrainingContractError(`Missing ${MANIFEST_FILE} in ${packageDir}`);
    }
    const manifest = validateManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        packageDir
    );
    const Worker = dependencies.Worker || JsonlWorkerClient;
    const worker = new Worker({
        command: resolveWorkerCommand(packageDir, manifest.worker.command),
        args: [
            resolveInside(packageDir, manifest.worker.entry, 'worker.entry'),
            ...(manifest.worker.args || []),
        ],
        cwd: packageDir,
        env: manifest.worker.env || {},
        timeoutMs: manifest.worker.timeoutMs,
        maxLineBytes: manifest.worker.maxLineBytes,
    });
    const model = createWorkerModelAdapter({
        id: manifest.id,
        capabilities: manifest.capabilities,
        metadata: {
            ...(manifest.metadata || {}),
            packageDir: manifest.packageDir,
            artifacts: manifest.resolvedArtifacts,
        },
        worker,
    });
    const algorithms = manifest.algorithms.map(
        (descriptor) => createPackageAlgorithm(manifest.id, descriptor)
    );
    const defaultDescriptor = manifest.algorithms.find((item) => item.default)
        || manifest.algorithms[0];

    return {
        manifest,
        model,
        algorithms,
        defaultAlgorithmId: `${manifest.id}/${defaultDescriptor.id}`,
        worker,
    };
}

function discoverModelPackages(root, dependencies = {}) {
    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot)) return { packages: [], errors: [] };

    const packages = [];
    const errors = [];
    const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const packageDir = path.join(resolvedRoot, entry.name);
        if (!fs.existsSync(path.join(packageDir, MANIFEST_FILE))) continue;
        try {
            packages.push(loadModelPackage(packageDir, dependencies));
        } catch (error) {
            errors.push({ directory: entry.name, error: error.message });
        }
    }
    return { packages, errors };
}

module.exports = {
    MANIFEST_VERSION,
    MANIFEST_FILE,
    REQUIRED_ARTIFACTS,
    validateManifest,
    loadModelPackage,
    discoverModelPackages,
};
