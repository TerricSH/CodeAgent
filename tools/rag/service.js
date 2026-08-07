const RagCompiler = require('./compiler');
const RagQuery = require('./query');
const { validateCollection, safeString } = require('./contracts');

// 兼容 JavaScript API 的轻量 façade。编译与查询实现分别归 RagCompiler/RagQuery；
// 本类只负责组装、管理操作和共享资源生命周期。
class RagService {
    constructor({
        repository,
        embeddingProvider,
        rerankProvider,
        modelWorker = null,
        config,
        compiler = null,
        query = null,
    }) {
        if (!repository) throw new Error('RAG repository is required');
        if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') {
            throw new Error('RAG embedding provider is required');
        }
        if (!rerankProvider || typeof rerankProvider.rerank !== 'function') {
            throw new Error('RAG rerank provider is required');
        }
        if (!config) throw new Error('RAG config is required');
        this.repository = repository;
        this.embeddingProvider = embeddingProvider;
        this.rerankProvider = rerankProvider;
        this.modelWorker = modelWorker;
        this.config = config;
        this.compiler = compiler || new RagCompiler({ repository, embeddingProvider, config });
        this.query = query || new RagQuery({
            repository,
            embeddingProvider,
            rerankProvider,
            config,
        });
    }

    ingestText(options) {
        return this.compiler.compileText(options);
    }

    search(options) {
        return this.query.search(options);
    }

    listDocuments(options) {
        return this.query.listDocuments(options);
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

module.exports = { RagService, validateCollection, RagCompiler, RagQuery };
