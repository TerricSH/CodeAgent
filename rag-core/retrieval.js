const { normalizeVector } = require('../model/vector');

class SemanticRetriever {
    constructor({ repository, embeddingProvider, dimensions = null } = {}) {
        this.repository = repository;
        this.embeddingProvider = embeddingProvider;
        this.dimensions = dimensions;
    }

    async retrieve({ query, collection, embeddingModel, limit }) {
        const vectors = await this.embeddingProvider.embed([query]);
        if (vectors.length !== 1) throw new Error('Embedding provider did not return one query vector');
        const vector = normalizeVector(vectors[0], 'query embedding');
        if (this.dimensions && vector.length !== this.dimensions) {
            throw new Error(
                `Query embedding has ${vector.length} dimensions; RAG_EMBEDDING_DIMENSIONS is ${this.dimensions}`
            );
        }
        return this.repository.searchChunks(collection, embeddingModel, vector, limit);
    }
}

class KeywordRetriever {
    constructor({ repository } = {}) {
        this.repository = repository;
    }

    retrieve({ query, collection, limit }) {
        return typeof this.repository.searchKeywordChunks === 'function'
            ? this.repository.searchKeywordChunks(collection, query, limit)
            : Promise.resolve([]);
    }
}

class CandidateFusion {
    constructor({ fuse } = {}) {
        this.fuse = fuse;
    }

    combine(lists, limit) {
        return this.fuse(lists, { weights: lists.map(() => 1) }).slice(0, limit);
    }
}

class Reranker {
    constructor({ provider } = {}) {
        this.provider = provider;
    }

    rank(query, candidates, topK) {
        return this.provider.rerank(query, candidates.map(candidate => candidate.content), { topN: topK });
    }
}

module.exports = { SemanticRetriever, KeywordRetriever, CandidateFusion, Reranker };
