const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathIsInside } = require('../sandbox/workspace');

function stringifyJson(value) {
    const ancestors = [];
    return JSON.stringify(value, function replace(_key, item) {
        if (typeof item === 'bigint') return item.toString();
        if (!item || typeof item !== 'object') return item;
        while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(item)) return '[Circular]';
        ancestors.push(item);
        return item;
    });
}

function appendJsonl(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${stringifyJson(value)}\n`, 'utf8');
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

class TrajectoryJournal {
    constructor(artifactRoot, options = {}) {
        this.artifactRoot = path.resolve(artifactRoot);
        this.transportPath = path.join(this.artifactRoot, 'transport-attempts.jsonl');
        this.rawPath = path.join(this.artifactRoot, 'raw-semantic-events.jsonl');
        this.cleanedPath = path.join(this.artifactRoot, 'cleaned-trajectories.jsonl');
        this.exclusionsPath = path.join(this.artifactRoot, 'excluded-attempts.jsonl');
        this.blobRoot = path.join(this.artifactRoot, 'trajectory-blobs');
        this.maxInlineChars = Math.max(1, Number(options.maxInlineChars) || 100000);
        this._sequence = 0;
        this._excludedAttemptKeys = new Set();
        fs.mkdirSync(this.artifactRoot, { recursive: true });
        for (const file of [
            this.transportPath,
            this.rawPath,
            this.cleanedPath,
            this.exclusionsPath,
        ]) {
            if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
        }
    }

    recordTransportAttempt(record) {
        appendJsonl(this.transportPath, {
            schemaVersion: 2,
            recordType: 'model-transport-attempt',
            createdAt: new Date().toISOString(),
            ...record,
        });
    }

    commitModelEvents(batch) {
        this.recordSemanticEvent({
            eventId: crypto.randomUUID(),
            logicalCallId: batch.logicalCallId,
            attemptNo: batch.attemptNo,
            type: 'model_request',
            recordType: 'model-request',
            purpose: batch.purpose || null,
            model: batch.model || null,
            content: null,
            payload: {
                messages: batch.messages || [],
                tools: batch.tools || [],
                context: batch.context || null,
            },
        });
        for (const event of batch.events || []) {
            this.recordSemanticEvent({
                ...event,
                recordType: 'model-event',
                purpose: batch.purpose || null,
                model: batch.model || null,
                context: batch.context || null,
            });
        }
    }

    recordSemanticEvent(event) {
        this._sequence += 1;
        appendJsonl(this.rawPath, {
            ...event,
            schemaVersion: 2,
            globalSequence: this._sequence,
            createdAt: event.createdAt || new Date().toISOString(),
            eventId: event.eventId || crypto.randomUUID(),
        });
    }

    checkpoint() {
        return this._sequence;
    }

    excludeAttempt(attemptKey, details = {}) {
        const key = String(attemptKey || '').trim();
        if (!key || this._excludedAttemptKeys.has(key)) return;
        this._excludedAttemptKeys.add(key);
        appendJsonl(this.exclusionsPath, {
            schemaVersion: 2,
            recordType: 'excluded-rollout-attempt',
            createdAt: new Date().toISOString(),
            attemptKey: key,
            ...details,
        });
    }

    _eventAttemptKey(event) {
        return event?.context?.attemptKey
            || event?.payload?.context?.attemptKey
            || null;
    }

    _cleanPath(requested) {
        if (!requested) return this.cleanedPath;
        const resolved = path.resolve(this.artifactRoot, requested);
        if (!pathIsInside(this.artifactRoot, resolved)) {
            throw new Error('Cleaned trajectory path escaped its artifact root');
        }
        return resolved;
    }

    _content(value) {
        const content = value == null ? '' : String(value);
        if (content.length <= this.maxInlineChars) return { content, blobRef: null };
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        const file = path.join(this.blobRoot, `${hash}.txt`);
        fs.mkdirSync(this.blobRoot, { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, content, 'utf8');
        return {
            content: null,
            blobRef: {
                path: file,
                sha256: hash,
                chars: content.length,
            },
        };
    }

    clean(options = {}) {
        const afterSequence = Number.isInteger(options.afterSequence)
            ? options.afterSequence
            : 0;
        const throughSequence = Number.isInteger(options.throughSequence)
            ? options.throughSequence
            : Number.MAX_SAFE_INTEGER;
        const outputPath = this._cleanPath(options.path);
        const raw = readJsonl(this.rawPath).sort(
            (left, right) => left.globalSequence - right.globalSequence
        ).filter(event => (
            event.globalSequence > afterSequence
            && event.globalSequence <= throughSequence
            && !this._excludedAttemptKeys.has(this._eventAttemptKey(event))
        ));
        const cleaned = [];
        for (const event of raw) {
            const kind = event.type === 'thinking'
                ? 'reasoning'
                : (event.type === 'content' ? 'content' : event.type);
            if (kind === 'tool_started') {
                cleaned.push({
                    schemaVersion: 2,
                    recordType: 'cleaned-trajectory-span',
                    spanId: crypto.randomUUID(),
                    kind: 'tool',
                    logicalCallId: event.logicalCallId || null,
                    purpose: event.purpose || null,
                    model: event.model || null,
                    startedAt: event.createdAt,
                    finishedAt: null,
                    sourceEventIds: event.eventId ? [event.eventId] : [],
                    toolCallId: event.payload?.toolCallId || null,
                    name: event.payload?.name || null,
                    arguments: event.payload?.arguments || {},
                    status: 'started',
                    context: event.payload?.context || null,
                    _fullContent: '',
                });
                continue;
            }
            if (kind === 'tool_result') {
                const tool = [...cleaned].reverse().find(span => (
                    span.kind === 'tool'
                    && span.toolCallId
                    && span.toolCallId === event.payload?.toolCallId
                    && span.status === 'started'
                ));
                if (tool) {
                    tool._fullContent = event.content || '';
                    if (event.eventId) tool.sourceEventIds.push(event.eventId);
                    tool.finishedAt = event.createdAt;
                    tool.status = event.payload?.status || 'succeeded';
                    tool.errorCode = event.payload?.errorCode || null;
                    continue;
                }
            }
            const previous = cleaned.at(-1);
            const mergeable = (kind === 'reasoning' || kind === 'content')
                && previous
                && previous.kind === kind
                && previous.logicalCallId === event.logicalCallId
                && previous.purpose === event.purpose;
            if (mergeable) {
                previous._fullContent += event.content || '';
                previous.sourceEventIds.push(event.eventId);
                previous.finishedAt = event.createdAt;
                continue;
            }
            cleaned.push({
                schemaVersion: 2,
                recordType: 'cleaned-trajectory-span',
                spanId: crypto.randomUUID(),
                kind,
                logicalCallId: event.logicalCallId || null,
                purpose: event.purpose || null,
                model: event.model || null,
                context: event.context || event.payload?.context || null,
                startedAt: event.createdAt,
                finishedAt: event.createdAt,
                sourceEventIds: event.eventId ? [event.eventId] : [],
                calls: event.calls,
                payload: event.payload,
                _fullContent: event.content || '',
            });
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const lines = cleaned.map(span => {
            const stored = this._content(span._fullContent);
            const { _fullContent, ...output } = span;
            return stringifyJson({ ...output, ...stored });
        });
        fs.writeFileSync(outputPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
        return {
            path: outputPath,
            spans: readJsonl(outputPath),
            rawPath: this.rawPath,
            transportPath: this.transportPath,
            exclusionsPath: this.exclusionsPath,
            afterSequence,
            throughSequence,
        };
    }
}

module.exports = { TrajectoryJournal, appendJsonl, readJsonl, stringifyJson };
