const { loadRagConfig } = require('../tools/rag/config');
const LocalModelWorker = require('./local-model-worker');
const LocalEmbeddingProvider = require('./embedding-provider');
const LocalRerankProvider = require('./rerank-provider');

async function main() {
    const config = loadRagConfig();
    const worker = new LocalModelWorker(config.localModels);
    const embedding = new LocalEmbeddingProvider(worker, {
        modelId: config.localModels.embeddingId,
        modelPath: config.localModels.embeddingPath,
        dimensions: config.embedding.dimensions,
    });
    const reranker = new LocalRerankProvider(worker, {
        modelId: config.localModels.rerankId,
        modelPath: config.localModels.rerankPath,
    });

    try {
        const workerInfo = await worker.request('info');
        if (!workerInfo.offline || !workerInfo.telemetryDisabled) {
            throw new Error(`Local worker is not isolated: ${JSON.stringify(workerInfo)}`);
        }
        const vectors = await embedding.embed([
            'A vector database stores vectors and performs similarity search.',
            'The weather is pleasant today.',
        ]);
        const norm = Math.sqrt(vectors[0].reduce((sum, value) => sum + value * value, 0));
        if (Math.abs(norm - 1) > 1e-4) throw new Error(`Embedding is not normalized: ${norm}`);
        console.error('embedding-check=ok');

        const cases = [
            {
                name: 'english',
                query: 'What is a vector database used for?',
                documents: [
                    'It is a good day for a walk in the park.',
                    'A vector database stores embeddings and retrieves them by similarity.',
                    'A relational database organizes data into tables, rows, and columns.',
                ],
                expectedTop: 1,
            },
            {
                name: 'chinese',
                query: '\u5411\u91cf\u6570\u636e\u5e93\u6709\u4ec0\u4e48\u7528\u9014\uff1f',
                documents: [
                    '\u4eca\u5929\u9002\u5408\u53bb\u516c\u56ed\u6563\u6b65\u3002',
                    '\u5411\u91cf\u6570\u636e\u5e93\u8d1f\u8d23\u4fdd\u5b58\u5411\u91cf\uff0c\u5e76\u6309\u76f8\u4f3c\u5ea6\u6267\u884c\u68c0\u7d22\u3002',
                    '\u5173\u7cfb\u6570\u636e\u5e93\u901a\u5e38\u4f7f\u7528\u8868\u3001\u884c\u548c\u5217\u7ec4\u7ec7\u6570\u636e\u3002',
                ],
                expectedTop: 1,
            },
        ];
        const rerankChecks = {};
        for (const item of cases) {
            const ranked = await reranker.rerank(item.query, item.documents, {
                topN: item.documents.length,
            });
            if (ranked[0]?.index !== item.expectedTop) {
                throw new Error(`${item.name} rerank failed: ${JSON.stringify(ranked)}`);
            }
            rerankChecks[item.name] = {
                order: ranked.map((entry) => entry.index),
                topDocument: item.documents[ranked[0].index],
            };
            console.error(`rerank-check-${item.name}=ok`);
        }

        console.log(JSON.stringify({
            ok: true,
            offline: workerInfo.offline,
            telemetryDisabled: workerInfo.telemetryDisabled,
            embeddingModel: config.localModels.embeddingId,
            embeddingDimensions: vectors[0].length,
            workerEmbeddingDimensions: workerInfo.embeddingDimensions,
            embeddingNorm: norm,
            rerankModel: config.localModels.rerankId,
            rerankChecks,
        }, null, 2));
    } finally {
        await worker.dispose();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
