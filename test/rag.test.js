const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chunkText } = require('../tools/rag/chunker');
const { listProjectFiles } = require('../tools/rag/project-files');
const { normalizeVector, dotProduct } = require('../model/vector');
const { RagService } = require('../tools/rag/service');
const RagRepository = require('../data-layer/repositories/rag-repository');
const LocalModelWorker = require('../model/local-model-worker');
const LocalEmbeddingProvider = require('../model/embedding-provider');
const LocalRerankProvider = require('../model/rerank-provider');
const ragTool = require('../tools/rag');
const { createRagService } = require('../tools/rag/runtime');
const tools = require('../tools');
const { createDefaultRegistry } = require('../plugins');

class FakeRepository {
    constructor() {
        this.documents = new Map();
        this.chunks = new Map();
    }

    _key(collection, id) { return `${collection}:${id}`; }

    findDocumentBySource(collection, source) {
        return [...this.documents.values()].find(
            (document) => document.collection === collection && document.source === source
        ) || null;
    }

    getDocument(collection, id) {
        return this.documents.get(this._key(collection, id)) || null;
    }

    upsertDocument(record, chunks) {
        const existing = record.source
            ? this.findDocumentBySource(record.collection, record.source)
            : this.getDocument(record.collection, record.id);
        const id = existing?.id || record.id;
        this.documents.set(this._key(record.collection, id), {
            ...record,
            id,
            createdAt: existing?.createdAt || record.createdAt,
        });
        this.chunks.set(id, chunks.map((chunk) => ({
            ...chunk,
            documentId: id,
            source: record.source,
            title: record.title,
            metadata: record.metadata,
            updatedAt: record.updatedAt,
        })));
        return id;
    }

    searchChunks(collection, embeddingModel, queryEmbedding, limit) {
        const documents = [...this.documents.values()].filter(
            (document) => document.collection === collection
                && document.embeddingModel === embeddingModel
        );
        return documents.flatMap((document) => this.chunks.get(document.id) || [])
            .map((chunk) => ({
                ...chunk,
                vectorScore: dotProduct(queryEmbedding, chunk.embedding),
            }))
            .filter((chunk) => chunk.vectorScore != null)
            .sort((left, right) => right.vectorScore - left.vectorScore)
            .slice(0, limit);
    }

    listDocuments(collection, limit) {
        return [...this.documents.values()]
            .filter((document) => document.collection === collection)
            .slice(0, limit)
            .map((document) => ({
                ...document,
                chunkCount: (this.chunks.get(document.id) || []).length,
            }));
    }

    deleteDocument(collection, id) {
        this.chunks.delete(id);
        return this.documents.delete(this._key(collection, id));
    }

    stats() {
        return {
            documents: this.documents.size,
            chunks: [...this.chunks.values()].reduce((sum, chunks) => sum + chunks.length, 0),
            collections: new Set([...this.documents.values()].map((item) => item.collection)).size,
        };
    }

    info() { return { backend: 'fake', configured: true }; }
}

class FakeEmbeddingProvider {
    constructor() { this.calls = 0; }
    info() { return { model: 'fake-embedding', configured: true }; }
    async embed(inputs) {
        this.calls += 1;
        return inputs.map((input) => {
            const text = String(input).toLowerCase();
            if (text.includes('beta')) return [0.8, 0.2];
            return [1, 0];
        });
    }
}

class ReverseReranker {
    info() { return { model: 'fake-rerank', configured: true }; }
    async rerank(query, documents, options) {
        return documents.map((content, index) => ({ index, score: index + 1 }))
            .reverse()
            .slice(0, options.topN);
    }
}

function createService(overrides = {}) {
    return new RagService({
        repository: overrides.repository || new FakeRepository(),
        embeddingProvider: overrides.embeddingProvider || new FakeEmbeddingProvider(),
        rerankProvider: overrides.rerankProvider || new ReverseReranker(),
        config: {
            defaultCollection: 'global',
            chunkSize: 100,
            chunkOverlap: 10,
            maxDocumentChars: 10_000,
            candidateLimit: 10,
            embedding: { dimensions: 2 },
        },
    });
}

test('RAG chunking preserves overlap and stable normalized offsets', () => {
    const text = `${'A'.repeat(80)}\n\n${'B'.repeat(80)}`;
    const chunks = chunkText(text, { chunkSize: 100, overlap: 10 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].index, 0);
    assert.ok(chunks[1].charStart < chunks[0].charEnd);
    assert.ok(chunks.every((chunk) => chunk.content.length <= 100));
});

test('RAG vectors normalize for cosine retrieval', () => {
    const vector = normalizeVector([3, 4]);
    assert.ok(Math.abs(vector[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(vector[1] - 0.8) < 1e-6);
    assert.ok(Math.abs(dotProduct(vector, vector) - 1) < 1e-6);
});

test('local embedding and rerank providers use only the model worker', async () => {
    const calls = [];
    const worker = {
        status: () => ({ running: true }),
        request: async (operation, payload) => {
            calls.push({ operation, payload });
            if (operation === 'embed') return payload.inputs.map((value) => [value.length, 1]);
            if (operation === 'rerank') {
                return [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }];
            }
            throw new Error('unexpected operation');
        },
    };
    const embedding = new LocalEmbeddingProvider(worker, {
        modelId: 'embed-test',
        modelPath: __dirname,
        dimensions: 2,
    });
    const rerank = new LocalRerankProvider(worker, {
        modelId: 'rerank-test',
        modelPath: __dirname,
    });
    const embeddings = await embedding.embed(['a', 'bb']);
    const result = await rerank.rerank('query', ['first', 'second'], { topN: 2 });

    assert.deepEqual(embeddings, [[1, 1], [2, 1]]);
    assert.deepEqual(result, [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
    assert.deepEqual(calls.map((call) => call.operation), ['embed', 'rerank']);
});

test('public RAG factory rejects replaceable model providers', () => {
    assert.throws(
        () => createRagService({ embeddingProvider: new FakeEmbeddingProvider() }),
        /fixed to local inference/
    );
    assert.throws(
        () => createRagService({ rerankProvider: new ReverseReranker() }),
        /fixed to local inference/
    );
    assert.throws(
        () => createRagService({ localModelWorker: { request() {} } }),
        /fixed to local inference/
    );
});

test('local RAG worker enforces offline mode and uses a JSONL subprocess', async () => {
    const worker = new LocalModelWorker({
        pythonCommand: 'python',
        workerPath: path.join(__dirname, 'fixtures', 'python-rag-worker.py'),
        embeddingPath: path.join(__dirname, 'fixtures'),
        rerankPath: path.join(__dirname, 'fixtures'),
        timeoutMs: 30_000,
    });
    try {
        const info = await worker.request('info');
        const embeddings = await worker.request('embed', { inputs: ['a', 'bb'] });
        const reranked = await worker.request('rerank', {
            query: 'q',
            documents: ['first', 'second'],
            topN: 1,
        });
        assert.equal(info.offline, true);
        assert.equal(info.telemetryDisabled, true);
        assert.equal(info.proxiesRemoved, true);
        assert.equal(info.utf8, true);
        assert.deepEqual(embeddings, [[1, 1], [2, 1]]);
        assert.deepEqual(reranked, [{ index: 1, score: 1 }]);
    } finally {
        await worker.dispose();
    }
});

test('RAG service ingests embeddings, retrieves candidates, and applies rerank order', async () => {
    const service = createService();
    await service.ingestText({ content: 'alpha knowledge', source: 'doc:alpha', title: 'Alpha' });
    await service.ingestText({ content: 'beta knowledge', source: 'doc:beta', title: 'Beta' });

    const result = await service.search({ query: 'alpha query', topK: 2 });
    assert.equal(result.count, 2);
    assert.equal(result.embeddingModel, 'fake-embedding');
    assert.equal(result.rerankModel, 'fake-rerank');
    assert.equal(result.results[0].source, 'doc:beta');
    assert.ok(result.results[0].rerankScore > result.results[1].rerankScore);
    assert.ok(result.results.every((item) => Number.isFinite(item.vectorScore)));
});

test('RAG ingestion is idempotent for an unchanged stable source', async () => {
    const embeddingProvider = new FakeEmbeddingProvider();
    const service = createService({ embeddingProvider });
    const first = await service.ingestText({ content: 'alpha knowledge', source: 'doc:stable' });
    const second = await service.ingestText({ content: 'alpha knowledge', source: 'doc:stable' });

    assert.equal(first.unchanged, false);
    assert.equal(second.unchanged, true);
    assert.equal(first.documentId, second.documentId);
    assert.equal(embeddingProvider.calls, 1);
});

test('RAG replaces metadata for the same source without changing document identity', async () => {
    const repository = new FakeRepository();
    const service = createService({ repository });
    const first = await service.ingestText({
        content: 'alpha knowledge',
        source: 'doc:metadata',
        title: 'Old title',
        metadata: { version: 1 },
    });
    const second = await service.ingestText({
        content: 'alpha knowledge',
        source: 'doc:metadata',
        title: 'New title',
        metadata: { version: 2 },
    });

    assert.equal(second.unchanged, false);
    assert.equal(second.documentId, first.documentId);
    assert.equal(repository.getDocument('global', first.documentId).title, 'New title');
    assert.deepEqual(repository.getDocument('global', first.documentId).metadata, { version: 2 });
});

test('pgvector repository validates schema names and vector dimensions', () => {
    assert.throws(
        () => new RagRepository({ schema: 'unsafe-schema' }),
        /safe identifier/
    );
    assert.equal(
        RagRepository.vectorLiteral(normalizeVector([3, 4]), 2),
        '[0.6000000238418579,0.800000011920929]'
    );
    assert.throws(
        () => RagRepository.vectorLiteral([1, 2], 3),
        /dimensions mismatch/
    );
    assert.throws(
        () => new RagRepository({ embeddingDimensions: 3072 }),
        /at most 2000 dimensions/
    );
    assert.equal(RagRepository.versionAtLeast('0.8.2', '0.8.0'), true);
    assert.equal(RagRepository.versionAtLeast('0.7.4', '0.8.0'), false);
});

test('RAG status reports an unconfigured PostgreSQL backend without breaking startup', async () => {
    const repository = new RagRepository({ embeddingDimensions: 2 });
    const service = createService({ repository });
    const status = await service.status();

    assert.equal(status.database.backend, 'postgresql+pgvector');
    assert.equal(status.database.configured, false);
    assert.equal(status.embedding.model, 'fake-embedding');
});

test('RAG fails closed when rerank returns no results', async () => {
    const service = createService({
        rerankProvider: {
            info: () => ({ model: 'broken-rerank' }),
            rerank: async () => [],
        },
    });
    await service.ingestText({ content: 'alpha knowledge', source: 'doc:alpha' });
    await assert.rejects(
        service.search({ query: 'alpha' }),
        /Rerank provider returned no results/
    );
});

test('RAG is one core tool and is not a default plugin', () => {
    assert.equal(ragTool.definition.function.name, 'rag');
    assert.equal(tools.has('rag'), true);
    assert.equal(tools.names().some(name => name.startsWith('rag__')), false);
    assert.equal(createDefaultRegistry().list().some(plugin => plugin.name === 'rag'), false);
});

test('RAG tool indexes Workspace files and prevents subagent mutation', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-rag-tool-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'app.js'), 'const answer = 42;', 'utf8');
    const calls = [];
    const fakeService = {
        async ingestText(options) {
            calls.push(options);
            return { unchanged: false, chunks: 1 };
        },
        async search(options) { return { query: options.query, results: [] }; },
        async dispose() {},
    };
    const services = {
        workspace: { status: () => ({ id: 'test', root }) },
        fileSystem: { resolveExisting: () => path.join(root, 'app.js') },
    };
    const context = {
        metadata: {},
        getService(name) { return services[name] || null; },
    };
    const handler = ragTool.createHandler({ createService: () => fakeService });

    const indexed = JSON.parse(await handler({ action: 'index_project' }, context));
    assert.equal(indexed.indexed, 1);
    assert.equal(calls[0].source, 'workspace:app.js');
    assert.equal(calls[0].collection, 'workspace:test');

    context.metadata = { type: 'subagent' };
    const blocked = JSON.parse(await handler({ action: 'index_project' }, context));
    assert.match(blocked.error, /may not index/);
});

test('RAG project scan excludes generated and workspace directories', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-rag-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = true;', 'utf8');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored', 'utf8');
    fs.mkdirSync(path.join(root, 'workspace'));
    fs.writeFileSync(path.join(root, 'workspace', 'ignored.js'), 'ignored', 'utf8');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide', 'utf8');

    assert.deepEqual(
        listProjectFiles(root).map(file => file.path),
        ['app.js', 'docs/guide.md']
    );
});
