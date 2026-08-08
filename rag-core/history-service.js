const { createRagRuntime } = require('../tools/rag/runtime');
const auditRepository = require('../data-layer/repositories/audit-repository');
const { HistoryAdapter } = require('./adapters');

class HistoryRagService {
    constructor(options = {}) {
        this.runtimeFactory = options.runtimeFactory || createRagRuntime;
        this.auditRepository = options.auditRepository || auditRepository;
        this.adapter = options.adapter || new HistoryAdapter();
    }

    async indexPending(sessionIds, runtime, options = {}) {
        const events = await this.auditRepository.claimIndexEvents({
            sessionIds,
            limit: options.limit || 25,
        });
        const result = { claimed: events.length, indexed: 0, failed: 0 };
        for (const event of events) {
            try {
                const documents = this.adapter.documents(event);
                for (const document of documents) {
                    if (!document.content.trim()) continue;
                    await runtime.compiler.compileText(document);
                    if (event.eventType === 'memory.forgotten'
                        && event.payload?.memoryId
                        && typeof runtime.repository.addTombstone === 'function') {
                        await runtime.repository.addTombstone(document.collection, event.payload.memoryId);
                    }
                }
                await this.auditRepository.completeIndexEvent(event.id);
                result.indexed += 1;
            } catch (error) {
                await this.auditRepository.completeIndexEvent(event.id, error.message);
                result.failed += 1;
            }
        }
        return result;
    }

    async search(options = {}) {
        const sessionIds = Array.isArray(options.sessionIds) ? options.sessionIds.filter(Boolean) : [];
        const collections = Array.isArray(options.collections) && options.collections.length > 0
            ? options.collections
            : sessionIds.map(id => this.adapter.collection(id));
        if (collections.length === 0) return { query: options.query || '', count: 0, hits: [] };
        const runtime = this.runtimeFactory({ defaultCollection: collections[0] });
        const emit = typeof options.eventSink === 'function' ? options.eventSink : () => {};
        try {
            if (sessionIds.length > 0 || options.indexAll) {
                await this.indexPending(options.indexAll ? [] : sessionIds, runtime, options);
            }
            const searches = await Promise.all(collections.map(collection => runtime.query.search({
                query: options.query,
                collection,
                topK: options.limit || 5,
                candidateLimit: options.candidateLimit,
                eventSink: emit,
            })));
            const seen = new Set();
            const hits = searches.flatMap(result => result.results)
                .sort((left, right) => (right.rerankScore || 0) - (left.rerankScore || 0))
                .filter(item => {
                    const key = `${item.documentId}:${item.chunkIndex}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return item.metadata?.eventType !== 'memory.forgotten';
                })
                .slice(0, Math.min(Math.max(Number(options.limit) || 5, 1), 20));
            return { query: options.query || '', collections, count: hits.length, hits };
        } finally {
            if (typeof runtime.dispose === 'function') await runtime.dispose();
        }
    }
}

module.exports = HistoryRagService;
