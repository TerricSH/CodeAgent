const { normalizeVector } = require('../../model/vector');
const {
    boundedInteger,
    validateCollection,
    safeString,
    embeddingModel,
} = require('./contracts');

class RagQuery {
    constructor({ repository, embeddingProvider, rerankProvider, config } = {}) {
        if (!repository) throw new Error('RAG query repository is required');
        if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') {
            throw new Error('RAG query embedding provider is required');
        }
        if (!rerankProvider || typeof rerankProvider.rerank !== 'function') {
            throw new Error('RAG query rerank provider is required');
        }
        if (!config) throw new Error('RAG query config is required');
        this.repository = repository;
        this.embeddingProvider = embeddingProvider;
        this.rerankProvider = rerankProvider;
        this.config = config;
    }

    async search(options = {}) {
        const query = safeString(options.query, 10_000, 'RAG query', true);
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const topK = boundedInteger(options.topK, 5, 1, 20);
        const candidateLimit = boundedInteger(
            options.candidateLimit,
            Math.max(this.config.candidateLimit, topK),
            topK,
            200
        );
        const model = embeddingModel(this.embeddingProvider);
        const queryEmbeddings = await this.embeddingProvider.embed([query]);
        if (queryEmbeddings.length !== 1) {
            throw new Error('Embedding provider did not return one query vector');
        }
        const queryVector = normalizeVector(queryEmbeddings[0], 'query embedding');
        const configuredDimensions = this.config.embedding?.dimensions;
        if (configuredDimensions && queryVector.length !== configuredDimensions) {
            throw new Error(
                `Query embedding has ${queryVector.length} dimensions; `
                + `RAG_EMBEDDING_DIMENSIONS is ${configuredDimensions}`
            );
        }
        const candidates = await this.repository.searchChunks(
            collection,
            model,
            queryVector,
            candidateLimit
        );
        for (const candidate of candidates) {
            if (!Number.isFinite(candidate.vectorScore)) {
                throw new Error('pgvector returned an invalid similarity score');
            }
        }

        const rerankModel = this.rerankProvider.info?.().model || null;
        if (candidates.length === 0) {
            return {
                query,
                collection,
                count: 0,
                embeddingModel: model,
                rerankModel,
                results: [],
            };
        }

        const reranked = await this.rerankProvider.rerank(
            query,
            candidates.map(candidate => candidate.content),
            { topN: topK }
        );
        if (!Array.isArray(reranked) || reranked.length === 0) {
            throw new Error('Rerank provider returned no results');
        }
        const seen = new Set();
        const results = [];
        for (const item of reranked) {
            if (!item || !Number.isInteger(item.index) || !Number.isFinite(item.score)) {
                throw new Error('Rerank provider returned an invalid result');
            }
            if (seen.has(item.index)) continue;
            seen.add(item.index);
            const candidate = candidates[item.index];
            if (!candidate) throw new Error('Rerank provider referenced a missing candidate');
            results.push({
                documentId: candidate.documentId,
                chunkIndex: candidate.chunkIndex,
                content: candidate.content,
                source: candidate.source,
                title: candidate.title,
                metadata: candidate.metadata,
                charStart: candidate.charStart,
                charEnd: candidate.charEnd,
                vectorScore: candidate.vectorScore,
                rerankScore: item.score,
                updatedAt: candidate.updatedAt,
            });
            if (results.length >= topK) break;
        }

        return {
            query,
            collection,
            count: results.length,
            candidateCount: candidates.length,
            embeddingModel: model,
            rerankModel,
            results,
        };
    }

    async listDocuments(options = {}) {
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const limit = boundedInteger(options.limit, 50, 1, 200);
        return { collection, documents: await this.repository.listDocuments(collection, limit) };
    }
}

module.exports = RagQuery;
