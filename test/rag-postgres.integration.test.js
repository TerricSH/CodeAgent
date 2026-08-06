const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const RagRepository = require('../data-layer/repositories/rag-repository');
const { RagService } = require('../tools/rag/service');

const connectionString = process.env.RAG_TEST_POSTGRES_URL;

test('PostgreSQL pgvector RAG integration', { skip: !connectionString }, async () => {
    const schema = `codeagent_rag_test_${process.pid}_${Date.now()}`;
    const pool = new Pool({ connectionString, max: 2 });
    const repository = new RagRepository({
        pool,
        schema,
        embeddingDimensions: 2,
    });
    const embeddingProvider = {
        info: () => ({ model: 'integration-embedding', dimensions: 2, configured: true }),
        embed: async (inputs) => inputs.map((input) => (
            String(input).includes('beta') ? [0, 1] : [1, 0]
        )),
    };
    const rerankProvider = {
        info: () => ({ model: 'integration-rerank', configured: true }),
        rerank: async (query, documents, options) => documents
            .map((content, index) => ({ index, score: content.includes('beta') ? 1 : 0.5 }))
            .sort((left, right) => right.score - left.score)
            .slice(0, options.topN),
    };
    const service = new RagService({
        repository,
        embeddingProvider,
        rerankProvider,
        config: {
            defaultCollection: 'global',
            chunkSize: 100,
            chunkOverlap: 10,
            maxDocumentChars: 10_000,
            candidateLimit: 10,
            embedding: { dimensions: 2 },
        },
    });

    try {
        const alpha = await service.ingestText({ content: 'alpha knowledge', source: 'doc:alpha' });
        await service.ingestText({ content: 'beta knowledge', source: 'doc:beta' });
        const result = await service.search({ query: 'alpha query', topK: 2 });

        assert.equal(result.results.length, 2);
        assert.equal(result.results[0].source, 'doc:beta');
        assert.equal((await service.listDocuments()).documents.length, 2);
        assert.equal((await service.deleteDocument({ documentId: alpha.documentId })).deleted, true);
        assert.equal((await repository.stats()).documents, 1);
    } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
    }
});
