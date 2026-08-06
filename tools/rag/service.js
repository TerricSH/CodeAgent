const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { chunkText, normalizeText } = require('./chunker');
const { normalizeVector } = require('../../model/vector');

function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function validateCollection(value, fallback) {
    const collection = String(value || fallback || 'global').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(collection)) {
        throw new Error('RAG collection must be 1-128 safe identifier characters');
    }
    return collection;
}

function safeString(value, max, label, required = false) {
    const text = value == null ? '' : String(value).trim();
    if (required && !text) throw new Error(`${label} is required`);
    if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return text || null;
}

class RagService {
    constructor({ repository, embeddingProvider, rerankProvider, modelWorker = null, config }) {
        if (!repository) throw new Error('RAG repository is required');
        if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') {
            throw new Error('RAG embedding provider is required');
        }
        if (!rerankProvider || typeof rerankProvider.rerank !== 'function') {
            throw new Error('RAG rerank provider is required');
        }
        this.repository = repository;
        this.embeddingProvider = embeddingProvider;
        this.rerankProvider = rerankProvider;
        this.modelWorker = modelWorker;
        this.config = config;
    }

    _embeddingModel() {
        const info = typeof this.embeddingProvider.info === 'function'
            ? this.embeddingProvider.info()
            : {};
        return info.model || this.embeddingProvider.model || 'unknown';
    }

    async ingestText(options = {}) {
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const content = normalizeText(options.content);
        if (!content) throw new Error('RAG document content is required');
        if (content.length > this.config.maxDocumentChars) {
            throw new Error(`RAG document exceeds ${this.config.maxDocumentChars} characters`);
        }
        const requestedSource = options.source === undefined
            ? undefined
            : safeString(options.source, 2000, 'RAG source');
        const requestedTitle = options.title === undefined
            ? undefined
            : safeString(options.title, 500, 'RAG title');
        const requestedId = safeString(options.documentId, 200, 'RAG documentId');
        let existing = requestedSource
            ? await this.repository.findDocumentBySource(collection, requestedSource)
            : null;
        if (!existing && requestedId) {
            existing = await this.repository.getDocument(collection, requestedId);
        }
        const source = requestedSource === undefined ? existing?.source || null : requestedSource;
        const title = requestedTitle === undefined ? existing?.title || null : requestedTitle;
        const metadata = options.metadata && typeof options.metadata === 'object'
            ? options.metadata
            : existing?.metadata || {};
        const embeddingModel = this._embeddingModel();
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        if (existing && options.replace === false) {
            throw new Error(`RAG document already exists: ${existing.id}`);
        }
        if (existing
            && existing.contentHash === contentHash
            && existing.embeddingModel === embeddingModel
            && existing.title === title
            && isDeepStrictEqual(existing.metadata, metadata)) {
            return {
                ok: true,
                unchanged: true,
                documentId: existing.id,
                collection,
                contentHash,
            };
        }

        const chunks = chunkText(content, {
            chunkSize: this.config.chunkSize,
            overlap: this.config.chunkOverlap,
        });
        const embeddings = await this.embeddingProvider.embed(chunks.map((chunk) => chunk.content));
        if (embeddings.length !== chunks.length) {
            throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`);
        }

        let dimensions = null;
        const storedChunks = chunks.map((chunk, index) => {
            const embedding = normalizeVector(embeddings[index], `embedding[${index}]`);
            if (dimensions == null) dimensions = embedding.length;
            if (embedding.length !== dimensions) {
                throw new Error(`Embedding dimensions are inconsistent at chunk ${index}`);
            }
            const configuredDimensions = this.config.embedding?.dimensions;
            if (configuredDimensions && embedding.length !== configuredDimensions) {
                throw new Error(
                    `Embedding provider returned ${embedding.length} dimensions; `
                    + `RAG_EMBEDDING_DIMENSIONS is ${configuredDimensions}`
                );
            }
            return {
                ...chunk,
                embedding,
            };
        });
        const now = new Date().toISOString();
        const documentId = await this.repository.upsertDocument({
            id: existing?.id || requestedId || crypto.randomUUID(),
            collection,
            source,
            title,
            contentHash,
            metadata,
            embeddingModel,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        }, storedChunks);

        return {
            ok: true,
            unchanged: false,
            documentId,
            collection,
            contentHash,
            chunks: storedChunks.length,
            embeddingModel,
            embeddingDimensions: dimensions,
        };
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
        const embeddingModel = this._embeddingModel();
        const queryEmbeddings = await this.embeddingProvider.embed([query]);
        if (queryEmbeddings.length !== 1) throw new Error('Embedding provider did not return one query vector');
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
            embeddingModel,
            queryVector,
            candidateLimit
        );
        for (const candidate of candidates) {
            if (!Number.isFinite(candidate.vectorScore)) {
                throw new Error('pgvector returned an invalid similarity score');
            }
        }

        if (candidates.length === 0) {
            return {
                query,
                collection,
                count: 0,
                embeddingModel,
                rerankModel: this.rerankProvider.info?.().model || null,
                results: [],
            };
        }

        const reranked = await this.rerankProvider.rerank(
            query,
            candidates.map((candidate) => candidate.content),
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
            embeddingModel,
            rerankModel: this.rerankProvider.info?.().model || null,
            results,
        };
    }

    async listDocuments(options = {}) {
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const limit = boundedInteger(options.limit, 50, 1, 200);
        return { collection, documents: await this.repository.listDocuments(collection, limit) };
    }

    async deleteDocument(options = {}) {
        const collection = validateCollection(options.collection, this.config.defaultCollection);
        const documentId = safeString(options.documentId, 200, 'RAG documentId', true);
        return {
            collection,
            documentId,
            deleted: await this.repository.deleteDocument(collection, documentId),
        };
    }

    async status() {
        const database = this.repository.info?.() || { configured: true };
        if (database.configured !== false) {
            try {
                Object.assign(database, await this.repository.stats());
            } catch (error) {
                database.error = error instanceof Error ? error.message : String(error);
            }
        }
        return {
            database,
            defaultCollection: this.config.defaultCollection,
            chunkSize: this.config.chunkSize,
            chunkOverlap: this.config.chunkOverlap,
            embedding: this.embeddingProvider.info?.() || { configured: true },
            rerank: this.rerankProvider.info?.() || { configured: true },
        };
    }

    async dispose() {
        if (this.modelWorker && typeof this.modelWorker.dispose === 'function') {
            await this.modelWorker.dispose();
        }
        if (this.repository && typeof this.repository.close === 'function') {
            await this.repository.close();
        }
    }
}

module.exports = { RagService, validateCollection };
