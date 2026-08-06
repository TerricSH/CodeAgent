const fs = require('node:fs');

class LocalRerankProvider {
    constructor(worker, config = {}) {
        if (!worker || typeof worker.request !== 'function') {
            throw new Error('Local rerank provider requires a model worker');
        }
        this.worker = worker;
        this.model = config.modelId || 'local-reranker';
        this.modelPath = config.modelPath || null;
    }

    info() {
        return {
            type: 'local-cross-encoder',
            model: this.model,
            modelPath: this.modelPath,
            configured: Boolean(this.modelPath && fs.existsSync(this.modelPath)),
            worker: this.worker.status?.() || null,
        };
    }

    async rerank(query, documents, options = {}) {
        if (!Array.isArray(documents) || documents.length === 0) return [];
        const topN = Math.min(Math.max(Number(options.topN) || documents.length, 1), documents.length);
        const result = await this.worker.request('rerank', {
            query: String(query),
            documents: documents.map(String),
            topN,
        });
        if (!Array.isArray(result)) throw new Error('Local rerank worker returned an invalid response');
        return result.map((item) => {
            const index = Number(item?.index);
            const score = Number(item?.score);
            if (!Number.isInteger(index) || index < 0 || index >= documents.length) {
                throw new Error('Local rerank worker returned an invalid document index');
            }
            if (!Number.isFinite(score)) throw new Error('Local rerank worker returned an invalid score');
            return { index, score };
        }).sort((left, right) => right.score - left.score).slice(0, topN);
    }
}

module.exports = LocalRerankProvider;
