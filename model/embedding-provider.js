const fs = require('node:fs');
const { toFiniteVector } = require('./vector');

class LocalEmbeddingProvider {
    constructor(worker, config = {}) {
        if (!worker || typeof worker.request !== 'function') {
            throw new Error('Local embedding provider requires a model worker');
        }
        this.worker = worker;
        this.model = config.modelId || 'local-embedding';
        this.modelPath = config.modelPath || null;
        this.dimensions = Number.isInteger(config.dimensions) ? config.dimensions : null;
    }

    info() {
        return {
            type: 'local-sentence-transformer',
            model: this.model,
            modelPath: this.modelPath,
            dimensions: this.dimensions,
            configured: Boolean(this.modelPath && fs.existsSync(this.modelPath)),
            worker: this.worker.status?.() || null,
        };
    }

    async embed(inputs) {
        if (!Array.isArray(inputs) || inputs.length === 0) return [];
        const result = await this.worker.request('embed', { inputs: inputs.map(String) });
        if (!Array.isArray(result) || result.length !== inputs.length) {
            throw new Error(`Local embedding worker returned ${result?.length || 0} vectors for ${inputs.length} inputs`);
        }
        return result.map((embedding, index) => {
            const vector = Array.from(toFiniteVector(embedding, `embedding[${index}]`));
            if (this.dimensions && vector.length !== this.dimensions) {
                throw new Error(
                    `Local embedding model returned ${vector.length} dimensions; expected ${this.dimensions}`
                );
            }
            return vector;
        });
    }
}

module.exports = LocalEmbeddingProvider;
