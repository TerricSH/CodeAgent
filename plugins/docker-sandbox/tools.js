const fs = require('node:fs');
const path = require('node:path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

function format(value) {
    return JSON.stringify(value, null, 2);
}

function errorResult(error) {
    return format({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

function safe(handler) {
    return async (args, context, sandbox) => {
        if (!sandbox) return errorResult('Docker sandbox extension is unavailable');
        try {
            return format(await handler(args || {}, sandbox));
        } catch (error) {
            return errorResult(error);
        }
    };
}

const status = {
    prompt,
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_status',
            description: 'Check Docker Engine, sandbox image, isolation policy, and workspace readiness.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler: safe((args, sandbox) => sandbox.status()),
};

const exec = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_exec',
            description: 'Execute a non-interactive shell command inside the isolated Docker workspace.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command executed inside the container.' },
                    timeoutMs: { type: 'number', description: 'Timeout in milliseconds, capped by plugin policy.' },
                },
                required: ['command'],
            },
        },
    },
    handler: safe((args, sandbox) => sandbox.execute(args)),
};

const reset = {
    definition: {
        type: 'function',
        function: {
            name: 'sandbox_reset',
            description: 'Delete and recreate only the current session sandbox workspace.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    handler: safe((args, sandbox) => sandbox.reset()),
};

module.exports = [status, exec, reset];
