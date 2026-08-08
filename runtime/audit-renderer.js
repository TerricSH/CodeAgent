const fs = require('node:fs');
const path = require('node:path');
const auditRepository = require('../data-layer/repositories/audit-repository');

function fenced(value) {
    const text = value == null ? '' : String(value);
    const fence = text.includes('```') ? '````' : '```';
    return `${fence}\n${text}\n${fence}`;
}

function eventMarkdown(event) {
    const lines = [
        `### ${event.sequence}. ${event.eventType}`,
        '',
        `- Event: \`${event.id}\``,
        `- Trace: \`${event.traceId || '-'}\``,
        `- Span: \`${event.spanId || '-'}\``,
        `- Parent span: \`${event.parentSpanId || '-'}\``,
        `- Actor: \`${event.actor || '-'}\``,
        `- Time: \`${event.createdAt}\``,
        `- Tokens: ${event.tokenCount ?? '-'}`,
        `- Previous hash: \`${event.previousHash || '-'}\``,
        `- Event hash: \`${event.eventHash}\``,
    ];
    if (event.content != null) lines.push('', 'Content:', '', fenced(event.content));
    if (event.payload && Object.keys(event.payload).length > 0) {
        lines.push('', 'Payload:', '', fenced(JSON.stringify(event.payload, null, 2)));
    }
    return lines.join('\n');
}

class AuditRenderer {
    constructor(options = {}) {
        this.repository = options.repository || auditRepository;
    }

    async render(options = {}) {
        if (!options.sessionId && !options.traceId) {
            throw new Error('Audit export requires sessionId or traceId');
        }
        const readAll = this.repository.readAllEvents
            ? this.repository.readAllEvents.bind(this.repository)
            : this.repository.readEvents.bind(this.repository);
        let events = await readAll({
            sessionId: options.sessionId,
            traceId: options.traceId,
            fromSequence: options.fromSequence,
            toSequence: options.toSequence,
        });
        if (options.includeSubagents) {
            const seenSessions = new Set(events.map(event => event.sessionId));
            const queue = events
                .filter(event => event.eventType === 'subagent.started')
                .map(event => event.payload?.childSessionId)
                .filter(Boolean);
            while (queue.length > 0) {
                const sessionId = queue.shift();
                if (seenSessions.has(sessionId)) continue;
                seenSessions.add(sessionId);
                const childEvents = await readAll({ sessionId });
                events = [...events, ...childEvents];
                queue.push(...childEvents
                    .filter(event => event.eventType === 'subagent.started')
                    .map(event => event.payload?.childSessionId)
                    .filter(Boolean));
            }
        }
        const sessionIds = [...new Set(events.map(event => event.sessionId))];
        const validations = [];
        for (const sessionId of sessionIds) validations.push(await this.repository.verifySession(sessionId));
        const valid = validations.every(item => item.ok);
        const lines = [
            '# CodeAgent Audit Export',
            '',
            `- Generated: \`${new Date().toISOString()}\``,
            `- Session filter: \`${options.sessionId || '-'}\``,
            `- Trace filter: \`${options.traceId || '-'}\``,
            `- Event range: \`${options.fromSequence || 1}..${options.toSequence || 'end'}\``,
            `- Hash-chain validation: **${valid ? 'VALID' : 'INVALID'}**`,
            `- Event count: ${events.length}`,
            '',
            '## Validation details',
            '',
            fenced(JSON.stringify(validations, null, 2)),
            '',
            '## Events',
            '',
        ];
        for (const sessionId of sessionIds) {
            lines.push(`## Session ${sessionId}`, '');
            lines.push(...events.filter(event => event.sessionId === sessionId).map(eventMarkdown));
        }
        return { markdown: `${lines.join('\n\n')}\n`, events, validations, valid };
    }

    async export(options = {}) {
        const root = path.resolve(options.workspaceRoot || process.cwd());
        const requested = options.outputPath || path.join(
            '.code', 'exports', `${options.traceId || options.sessionId}-audit.md`
        );
        const target = path.resolve(root, requested);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
            throw new Error('Audit export path must stay inside the current Workspace');
        }
        const result = await this.render(options);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, result.markdown, 'utf8');
        return {
            outputPath: path.relative(root, target),
            eventCount: result.events.length,
            hashChainValid: result.valid,
            validations: result.validations,
        };
    }
}

module.exports = AuditRenderer;
