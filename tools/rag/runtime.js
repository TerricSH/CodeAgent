const { loadRagConfig } = require('./config');
const RagRepository = require('../../data-layer/repositories/rag-repository');
const { RagService } = require('./service');
const LocalModelWorker = require('../../model/local-model-worker');
const LocalEmbeddingProvider = require('../../model/embedding-provider');
const LocalRerankProvider = require('../../model/rerank-provider');

function createRagService(overrides = {}) {
    if (overrides.embeddingProvider || overrides.rerankProvider || overrides.localModelWorker) {
        throw new Error(
            'RAG model providers are fixed to local inference; configure localModels paths instead'
        );
    }
    const config = loadRagConfig(overrides);
    const repository = overrides.repository || new RagRepository({
        ...config.postgres,
        embeddingDimensions: config.embedding.dimensions,
        pool: overrides.postgres?.pool,
    });
    const modelWorker = new LocalModelWorker(config.localModels);
    const embeddingProvider = new LocalEmbeddingProvider(modelWorker, {
        modelId: config.localModels.embeddingId,
        modelPath: config.localModels.embeddingPath,
        dimensions: config.embedding.dimensions,
    });
    const rerankProvider = new LocalRerankProvider(modelWorker, {
        modelId: config.localModels.rerankId,
        modelPath: config.localModels.rerankPath,
    });
    return new RagService({
        repository,
        embeddingProvider,
        rerankProvider,
        modelWorker,
        config,
    });
}

module.exports = { createRagService, RagService };
