const prompt = `# Session history and memory

Use memory__session_search when the current request depends on exact past conversation details
that are not visible in the current context. Search the current session first. Search child
subagent sessions only when their investigation details are needed. Session search establishes
what was discussed; file and command tools establish what is currently true in the environment.

A reopened session may continue naturally without words such as "continue" or "previously".
Resolve vague references from the resume focus and current-session history before choosing an
environment target. If the reference remains ambiguous, search the current session; if multiple
targets are still plausible and a wrong choice would change files, ask the user instead of guessing.

Use memory__memory_remember only for explicit, stable decisions, preferences, or verified facts.
Never store credentials, transient reasoning, or large tool outputs. Subagents must not promote
their own findings into project memory; return candidates to the parent agent instead.`;

const sessionSearch = {
    prompt,
    definition: {
        type: 'function',
        function: {
            name: 'session_search',
            description: 'Search exact original messages in the current session or related subagent sessions.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                    mode: { type: 'string', enum: ['any', 'all', 'exact'] },
                    scope: { type: 'string', enum: ['current', 'children', 'descendants', 'session_tree', 'specific'] },
                    sessionId: { type: 'string' },
                    role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
                    limit: { type: 'number' },
                    around: { type: 'number' },
                },
                required: [],
            },
        },
    },
    handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return memory.searchSessions(args || {});
    },
};

const sessionReadRange = {
    definition: {
        type: 'function',
        function: {
            name: 'session_read_range',
            description: 'Read an exact message range from the current or a specified session.',
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
    handler(args, context, memory) {
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
    handler(args, context, memory) {
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
    handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return { id: memory.remember(args || {}) };
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
    handler(args, context, memory) {
        if (!memory) throw new Error('Memory extension is unavailable');
        return { forgotten: memory.forget(args || {}) };
    },
};

module.exports = [sessionSearch, sessionReadRange, memorySearch, memoryRemember, memoryForget];
