const crypto = require('node:crypto');

class SourceAdapter {
    constructor(domain, options = {}) {
        if (!domain) throw new Error('RAG SourceAdapter requires a domain');
        this.domain = domain;
        this.collectionPrefix = options.collectionPrefix || domain;
    }

    collection(scope = 'global') {
        return `${this.collectionPrefix}:${scope}`;
    }

    document(record) {
        return record;
    }
}

class ProjectAdapter extends SourceAdapter {
    constructor(options) { super('project', options); }
}

class HistoryAdapter extends SourceAdapter {
    constructor(options) { super('history', options); }

    document(event) {
        return {
            documentId: event.id,
            collection: this.collection(event.sessionId),
            source: `audit:${event.sessionId}:${event.sequence}`,
            title: `${event.eventType} #${event.sequence}`,
            content: [event.content, JSON.stringify(event.payload || {})].filter(Boolean).join('\n'),
            metadata: {
                domain: this.domain,
                sessionId: event.sessionId,
                traceId: event.traceId,
                spanId: event.spanId,
                sequence: event.sequence,
                eventType: event.eventType,
                actor: event.actor,
                memoryId: event.payload?.memoryId || null,
                memory: event.eventType?.startsWith('memory.') ? event.payload || {} : null,
            },
        };
    }

    memoryCollection(scope, ownerKey) {
        const ownerHash = crypto.createHash('sha256').update(String(ownerKey || '')).digest('hex').slice(0, 24);
        return `${this.collectionPrefix}:memory:${scope}:${ownerHash}`;
    }

    documents(event) {
        if (event.eventType === 'model.request'
            || event.eventType === 'model.system_prompt'
            || event.eventType === 'model.tool_schema'
            || event.eventType.startsWith('context.')) {
            return [];
        }
        const base = this.document(event);
        const documents = [base];
        const owners = event.eventType === 'memory.forgotten'
            ? (event.payload?.owners || [])
            : (event.payload?.scope && event.payload?.ownerKey
                ? [{ scope: event.payload.scope, ownerKey: event.payload.ownerKey }]
                : []);
        for (const owner of owners) {
            documents.push({
                ...base,
                documentId: `${event.id}:memory-scope:${owner.scope}`,
                collection: this.memoryCollection(owner.scope, owner.ownerKey),
                source: `${base.source}:memory-scope:${owner.scope}`,
            });
        }
        return documents;
    }
}

class SkillAdapter extends SourceAdapter {
    constructor(options) { super('skill', options); }

    document(skill) {
        return {
            documentId: skill.id || skill.name,
            collection: this.collection(skill.scope || 'installed'),
            source: skill.source || `skill:${skill.name}`,
            title: skill.name,
            content: skill.content,
            metadata: { domain: this.domain, name: skill.name, ...(skill.metadata || {}) },
        };
    }
}

module.exports = { SourceAdapter, ProjectAdapter, HistoryAdapter, SkillAdapter };
