const fs = require('node:fs');
const path = require('node:path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const sessionSearch = {
    prompt,
    definition: {
        type: 'function',
        function: {
            name: 'session_search',
            description: 'Locate relevant Audit history with semantic and keyword retrieval, fusion, and reranking.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                    scope: { type: 'string', enum: ['current', 'children', 'descendants', 'session_tree', 'specific'] },
                    sessionId: { type: 'string' },
                    limit: { type: 'number' },
                },
                required: [],
            },
        },
    },
    async handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return memory.searchSessions(args || {});
    },
};

const sessionReadRange = {
    definition: {
        type: 'function',
        function: {
            name: 'session_read_range',
            description: 'Read an exact Audit event sequence range from an authorized Session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string' },
                    start: { type: 'number' },
                    end: { type: 'number' },
                },
                required: ['start', 'end'],
            },
        },
    },
    async handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return memory.readSessionRange(args || {});
    },
};

const memorySearch = {
    definition: {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search saved session, project, or user memories when current context is insufficient.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                    scope: { type: 'string', enum: ['session', 'project', 'user', 'all'] },
                    limit: { type: 'number' },
                },
                required: [],
            },
        },
    },
    async handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return memory.searchMemories(args || {});
    },
};

const memoryRemember = {
    definition: {
        type: 'function',
        function: {
            name: 'memory_remember',
            description: 'Save an explicit stable decision, preference, or verified fact with source provenance.',
            parameters: {
                type: 'object',
                properties: {
                    scope: { type: 'string', enum: ['session', 'project', 'user'] },
                    type: { type: 'string', enum: ['working', 'episodic', 'semantic'] },
                    subject: { type: 'string' },
                    content: { type: 'string' },
                    importance: { type: 'number' },
                    confidence: { type: 'number' },
                    sourceMessageIndexes: { type: 'array', items: { type: 'number' } },
                    tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['content'],
            },
        },
    },
    async handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return { id: await memory.remember(args || {}) };
    },
};

const memoryForget = {
    definition: {
        type: 'function',
        function: {
            name: 'memory_forget',
            description: 'Logically forget a saved memory in the current session, project, or user scope.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
            },
        },
    },
    async handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return { forgotten: await memory.forget(args || {}) };
    },
};

module.exports = [sessionSearch, sessionReadRange, memorySearch, memoryRemember, memoryForget];
