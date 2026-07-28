const path = require('path');
const crypto = require('crypto');
const { TrainingRegistry } = require('./registry');
const { discoverModelPackages } = require('./model-package');
const { TrainingContractError } = require('./errors');

const STATE_VERSION = 1;

function truncateResult(value, maxChars = 16000) {
    if (value === undefined || value === null) return value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof text !== 'string') return String(value);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...[truncated]`;
}

class ModelPackageManager {
    constructor(config = {}, dependencies = {}) {
        this.root = path.resolve(
            config.root || path.join(process.cwd(), 'training', 'models')
        );
        this.dependencies = dependencies;
        this.registry = new TrainingRegistry();
        this.packages = new Map();
        this.discoveryErrors = [];
        this.runs = [];
        this.maxRuns = Number.isInteger(config.maxRuns) && config.maxRuns > 0
            ? config.maxRuns
            : 100;
        this.dirty = false;
    }

    discover() {
        const discovered = discoverModelPackages(this.root, this.dependencies);
        this.discoveryErrors = discovered.errors;
        for (const item of discovered.packages) {
            if (this.packages.has(item.model.id)) {
                item.worker.dispose();
                continue;
            }
            try {
                this.registry.registerModel(item.model);
                for (const algorithm of item.algorithms) {
                    this.registry.registerAlgorithm(algorithm);
                }
                this.packages.set(item.model.id, item);
            } catch (error) {
                this.discoveryErrors.push({
                    directory: path.basename(item.manifest.packageDir),
                    error: error.message,
                });
                item.worker.dispose();
            }
        }
        return this.list();
    }

    list() {
        return {
            root: this.root,
            models: [...this.packages.values()].map((item) => ({
                id: item.model.id,
                capabilities: { ...item.model.capabilities },
                algorithms: item.algorithms.map((algorithm) => algorithm.id),
                defaultAlgorithmId: item.defaultAlgorithmId,
                metadata: item.manifest.metadata || null,
            })),
            errors: this.discoveryErrors.slice(),
        };
    }

    check(modelId, algorithmId) {
        const item = this.packages.get(modelId);
        if (!item) throw new TrainingContractError(`Unknown model package: ${modelId}`);
        const selected = algorithmId || item.defaultAlgorithmId;
        return this.registry.compatibility(modelId, selected);
    }

    async train({ modelId, algorithmId, config = {} } = {}, trajectories) {
        const item = this.packages.get(modelId);
        if (!item) throw new TrainingContractError(`Unknown model package: ${modelId}`);
        const selected = algorithmId || item.defaultAlgorithmId;
        const binding = this.registry.bind(modelId, selected, config);
        const run = {
            id: crypto.randomUUID(),
            modelId,
            algorithmId: selected,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            status: 'running',
            trajectoryCount: Array.isArray(trajectories) ? trajectories.length : 0,
            result: null,
            error: null,
        };
        this.runs.push(run);
        if (this.runs.length > this.maxRuns) {
            this.runs.splice(0, this.runs.length - this.maxRuns);
        }
        this.dirty = true;

        try {
            const result = await binding.train(trajectories);
            run.status = 'completed';
            run.result = truncateResult(result);
            return { ...run, result };
        } catch (error) {
            run.status = 'failed';
            run.error = error.message;
            throw error;
        } finally {
            run.finishedAt = new Date().toISOString();
            this.dirty = true;
        }
    }

    history(limit = 20) {
        const count = Math.min(Math.max(1, Number(limit) || 20), 100);
        return this.runs.slice(-count).reverse().map((run) => ({ ...run }));
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || envelope.version !== STATE_VERSION || !Array.isArray(envelope.data)) {
            throw new TrainingContractError('Invalid training-manager state envelope');
        }
        this.runs = envelope.data.slice(-this.maxRuns);
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            name: 'training-manager',
            version: STATE_VERSION,
            data: this.runs,
        });
    }

    async dispose() {
        await Promise.all(
            [...this.packages.values()].map((item) => item.worker.dispose())
        );
    }
}

module.exports = { ModelPackageManager, truncateResult };
