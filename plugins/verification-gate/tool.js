const fs = require('node:fs');
const path = require('node:path');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const checkSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        command: { type: 'string' },
        timeoutMs: { type: 'integer' },
        path: { type: 'string' },
        exists: { type: 'boolean' },
        kind: { type: 'string', enum: ['file', 'directory'] },
        nonEmpty: { type: 'boolean' },
        contains: { type: 'string' },
        matches: { type: 'string' },
        assertions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    pointer: { type: 'string' },
                    exists: { type: 'boolean' },
                    valueType: { type: 'string', enum: ['null', 'boolean', 'number', 'string', 'array', 'object'] },
                    equals: {},
                },
                required: ['pointer'],
            },
        },
        config: {
            type: 'object',
            description: 'Provider-specific JSON configuration for a registered custom verifier type.',
            additionalProperties: true,
        },
    },
    required: ['id', 'type'],
};

const definition = {
    type: 'function',
    function: {
        name: 'verification_gate',
        description: 'Declare, propose, inspect, or run strong deterministic verification for the current Trace. Proposed plans require direct user approval.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['declare', 'plan', 'status', 'verify', 'request_override'] },
                checks: { type: 'array', items: checkSchema },
                reason: { type: 'string' },
            },
            required: ['action'],
        },
    },
};

async function handler(args, context, ext) {
    if (!ext) return JSON.stringify({ ok: false, error: 'verification-gate is unavailable' });
    try {
        if (args.action === 'declare') return JSON.stringify({ ok: true, gate: ext.declareRequired('agent') });
        if (args.action === 'plan') {
            return JSON.stringify({ ok: true, proposal: await ext.proposePlan({ checks: args.checks }) });
        }
        if (args.action === 'status') return JSON.stringify({ ok: true, gate: ext.status() });
        if (args.action === 'verify') return JSON.stringify({ ok: true, decision: await ext.verify() });
        if (args.action === 'request_override') {
            return JSON.stringify({ ok: true, override: await ext.requestOverride(args.reason) });
        }
        return JSON.stringify({ ok: false, error: `Unknown action: ${args.action}` });
    } catch (error) {
        return JSON.stringify({ ok: false, error: error.message, code: error.code || 'VERIFICATION_GATE_ERROR' });
    }
}

function effects(args = {}) {
    return args.action === 'verify' ? 'execute' : 'control';
}

module.exports = { definition, handler, prompt, effects };
