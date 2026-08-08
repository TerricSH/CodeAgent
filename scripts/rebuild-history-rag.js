require('dotenv').config();
const auditRepository = require('../data-layer/repositories/audit-repository');
const { createRagRuntime } = require('../tools/rag/runtime');
const HistoryRagService = require('../rag-core/history-service');
const { HistoryAdapter } = require('../rag-core/adapters');

async function rebuild(options = {}) {
    const sessions = await auditRepository.listAuditSessions(10000);
    const adapter = new HistoryAdapter();
    const runtime = createRagRuntime({ defaultCollection: 'history:rebuild' });
    const service = new HistoryRagService({ adapter });
    try {
        const events = await auditRepository.readAllEvents();
        const memoryCollections = new Set();
        for (const event of events) {
            for (const document of adapter.documents(event).slice(1)) memoryCollections.add(document.collection);
        }
        if (options.resume) {
            await auditRepository.requeueIndexEvents(['processing']);
        } else {
            for (const session of sessions) {
                await runtime.repository.deleteCollection(adapter.collection(session.sessionId));
            }
            for (const collection of memoryCollections) {
                await runtime.repository.deleteCollection(collection);
            }
            await auditRepository.resetIndexQueue();
        }
        let indexed = 0;
        while (true) {
            const batch = await service.indexPending([], runtime, { limit: 25 });
            indexed += batch.indexed;
            if (batch.claimed === 0) break;
        }
        return { sessions: sessions.length, memoryCollections: memoryCollections.size, indexed };
    } finally {
        await runtime.dispose();
    }
}

if (require.main === module) {
    rebuild({ resume: process.argv.includes('--resume') })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error(error.stack || error.message);
            process.exitCode = 1;
        });
}

module.exports = { rebuild };
