const fs = require('node:fs');
const path = require('node:path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

function format(value) {
    return JSON.stringify(value, null, 2);
}

const status = {
    prompt,
    effects: 'read',
    definition: {
        type: 'function',
        function: {
            name: 'workspace_status',
            description: 'Return the configured workspace root and its project/RAG scope identifiers.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler(args, context, workspace) {
        if (!workspace) throw new Error('Workspace extension is unavailable');
        return format(workspace.status());
    },
};

const requestAccess = {
    effects: 'control',
    definition: {
        type: 'function',
        function: {
            name: 'workspace_request_access',
            description: 'Ask the user to approve one exact operation outside the configured workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The exact path requiring access.' },
                    access: { type: 'string', enum: ['read', 'write', 'list'] },
                    reason: { type: 'string', description: 'Why this outside-workspace access is needed.' },
                },
                required: ['path', 'access', 'reason'],
            },
        },
    },
    async handler(args, context, workspace) {
        if (!workspace) throw new Error('Workspace extension is unavailable');
        return format(await workspace.requestAccess(args || {}));
    },
};

module.exports = [status, requestAccess];
