const path = require('node:path');

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadRagConfig(overrides = {}) {
    const env = process.env;
    const chunkSize = positiveInteger(overrides.chunkSize ?? env.RAG_CHUNK_SIZE, 1200);
    const requestedOverlap = nonNegativeInteger(overrides.chunkOverlap ?? env.RAG_CHUNK_OVERLAP, 200);
    const embeddingModelPath = path.resolve(
        overrides.localModels?.embeddingPath
        || env.RAG_LOCAL_EMBEDDING_MODEL
        || path.join(__dirname, '..', '..', 'model', 'models', 'bge-m3')
    );
    const rerankModelPath = path.resolve(
        overrides.localModels?.rerankPath
        || env.RAG_LOCAL_RERANK_MODEL
        || path.join(__dirname, '..', '..', 'model', 'models', 'bge-reranker-base')
    );

    return {
        postgres: {
            connectionString: overrides.postgres?.connectionString
                || env.CODEAGENT_POSTGRES_URL
                || env.RAG_POSTGRES_URL
                || env.DATABASE_URL
                || null,
            schema: overrides.postgres?.schema || env.RAG_POSTGRES_SCHEMA || 'codeagent_rag',
            maxConnections: positiveInteger(
                overrides.postgres?.maxConnections ?? env.RAG_POSTGRES_MAX_CONNECTIONS,
                10
            ),
            hnswEfSearch: positiveInteger(
                overrides.postgres?.hnswEfSearch ?? env.RAG_HNSW_EF_SEARCH,
                100
            ),
        },
        defaultCollection: String(overrides.defaultCollection || env.RAG_DEFAULT_COLLECTION || 'global'),
        chunkSize,
        chunkOverlap: Math.min(requestedOverlap, Math.max(0, chunkSize - 1)),
        maxDocumentChars: positiveInteger(
            overrides.maxDocumentChars ?? env.RAG_MAX_DOCUMENT_CHARS,
            2_000_000
        ),
        candidateLimit: positiveInteger(overrides.candidateLimit ?? env.RAG_CANDIDATE_LIMIT, 30),
        localModels: {
            pythonCommand: overrides.localModels?.pythonCommand
                || env.RAG_LOCAL_PYTHON
                || 'python',
            workerPath: path.resolve(
                overrides.localModels?.workerPath
                || path.join(__dirname, '..', '..', 'model', 'workers', 'local-model-worker.py')
            ),
            embeddingPath: embeddingModelPath,
            embeddingId: overrides.localModels?.embeddingId
                || env.RAG_LOCAL_EMBEDDING_MODEL_ID
                || path.basename(embeddingModelPath),
            rerankPath: rerankModelPath,
            rerankId: overrides.localModels?.rerankId
                || env.RAG_LOCAL_RERANK_MODEL_ID
                || path.basename(rerankModelPath),
            device: overrides.localModels?.device || env.RAG_LOCAL_DEVICE || 'cpu',
            batchSize: positiveInteger(
                overrides.localModels?.batchSize ?? env.RAG_LOCAL_BATCH_SIZE,
                32
            ),
            timeoutMs: positiveInteger(
                overrides.localModels?.timeoutMs ?? env.RAG_LOCAL_TIMEOUT_MS,
                10 * 60 * 1000
            ),
        },
        embedding: {
            model: overrides.localModels?.embeddingId
                || env.RAG_LOCAL_EMBEDDING_MODEL_ID
                || path.basename(embeddingModelPath),
            dimensions: positiveInteger(
                overrides.embedding?.dimensions ?? env.RAG_EMBEDDING_DIMENSIONS,
                1024
            ),
        },
        rerank: {
            model: overrides.localModels?.rerankId
                || env.RAG_LOCAL_RERANK_MODEL_ID
                || path.basename(rerankModelPath),
        },
    };
}

module.exports = { loadRagConfig };
