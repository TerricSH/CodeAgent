const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TrajectoryExtractor, AuditTrajectorySource } = require('../../trajectory-extraction');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'trajectory_extract',
        description: 'Extract a normal Audit trace/session or clean a Skill Refinement JSON/JSONL trajectory.',
        parameters: {
            type: 'object',
            properties: {
                sourceType: { type: 'string', enum: ['audit', 'file'] },
                sourcePath: { type: 'string' },
                traceId: { type: 'string' },
                sessionId: { type: 'string' },
                query: { type: 'string' },
                includeSubagents: { type: 'boolean' },
                includeReasoning: { type: 'boolean' },
                includeContextEvents: { type: 'boolean' },
                compare: { type: 'boolean' },
                outputPath: { type: 'string' },
            },
            required: [],
        },
    },
};

const capabilities = { required: ['fileSystem'], optional: ['auditStore'] };

function parseRecords(content) {
    const text = String(content || '').trim();
    if (!text) throw new Error('Trajectory source file is empty');
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed.records)) return parsed.records;
        if (Array.isArray(parsed.trajectories)) return parsed.trajectories;
        if (parsed && typeof parsed === 'object') return [parsed];
    } catch (error) {
        if (!text.includes('\n')) throw new Error(`Trajectory JSON is invalid: ${error.message}`);
    }
    return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
        try { return JSON.parse(line); }
        catch (error) { throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`); }
    });
}

function defaultOutputPath(fileSystem, source) {
    const relativeSource = fileSystem.relative(source);
    const extension = path.extname(relativeSource);
    const base = extension ? relativeSource.slice(0, -extension.length) : relativeSource;
    return `${base}.cleaned.json`;
}

function defaultAuditOutput(args) {
    const identity = args.traceId || args.sessionId
        || crypto.createHash('sha256').update(String(args.query || 'audit')).digest('hex').slice(0, 16);
    const safe = String(identity).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
    return path.join('.code', 'trajectories', `${safe}.cleaned.json`);
}

function resultSummary(result) {
    const trajectories = result.trajectories || [];
    return {
        trajectoryCount: trajectories.length,
        spans: trajectories.reduce((sum, item) => sum + Number(item.summary?.totalSpans || 0), 0),
        toolCalls: trajectories.reduce((sum, item) => sum + Number(item.summary?.toolCalls || 0), 0),
        failedToolCalls: trajectories.reduce(
            (sum, item) => sum + Number(item.summary?.failedToolCalls || 0),
            0
        ),
    };
}

function auditComparison(trajectories) {
    return trajectories.map(item => ({
        traceId: item.traceId,
        sessionId: item.sessionId,
        status: item.outcome?.status || 'unknown',
        totalEvents: item.summary?.totalEvents || 0,
        toolCalls: item.summary?.toolCalls || 0,
        failedToolCalls: item.summary?.failedToolCalls || 0,
    }));
}

function createHandler(options = {}) {
    const extractor = options.extractor || new TrajectoryExtractor(options.extractorOptions);
    return function handler(args = {}, context, injectedCapabilities = {}) {
        let fileSystem = null;
        const sourceType = args.sourceType || (args.sourcePath ? 'file' : 'audit');
        if (sourceType === 'audit') {
            return (async () => {
                try {
                    fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
                    const auditStore = injectedCapabilities.auditStore;
                    if (!auditStore) throw new Error('Audit Store capability is unavailable');
                    const source = options.auditSource || new AuditTrajectorySource({
                        auditRepository: auditStore,
                    });
                    const extractionOptions = {
                        includeSubagents: args.includeSubagents !== false,
                        includeReasoning: args.includeReasoning !== false,
                        includeContextEvents: args.includeContextEvents !== false,
                        sessionId: args.sessionId,
                    };
                    let trajectories;
                    if (args.traceId) trajectories = [await source.trace(args.traceId, extractionOptions)].filter(Boolean);
                    else if (args.sessionId && !args.query) trajectories = await source.session(args.sessionId, extractionOptions);
                    else if (args.query) trajectories = await source.query(args.query, extractionOptions);
                    else throw new Error('Audit extraction requires traceId, sessionId, or query');
                    const result = {
                        schemaVersion: 2,
                        sourceType: 'audit',
                        trajectories,
                        comparison: args.compare === false ? null : auditComparison(trajectories),
                    };
                    const requestedOutput = args.outputPath || defaultAuditOutput(args);
                    const output = fileSystem.resolveForWrite(requestedOutput);
                    fs.mkdirSync(path.dirname(output), { recursive: true });
                    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
                    return JSON.stringify({
                        ok: true,
                        sourceType,
                        source: args.traceId || args.sessionId || args.query,
                        outputPath: fileSystem.relative(output),
                        summary: resultSummary(result),
                        comparison: result.comparison,
                    }, null, 2);
                } catch (error) {
                    const formatted = formatCapabilityError(fileSystem, error, 'Trajectory extraction failed');
                    try { return JSON.stringify(JSON.parse(formatted), null, 2); }
                    catch { return JSON.stringify({ ok: false, error: formatted }, null, 2); }
                }
            })();
        }
        try {
            fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
            let result;
            let sourceLabel;
            let requestedOutput;
            if (!args.sourcePath) throw new Error('sourcePath is required for file trajectories');
            const source = fileSystem.resolveExisting(args.sourcePath, { type: 'file' });
            if (fs.statSync(source).size > 64 * 1024 * 1024) {
                throw new Error('Trajectory source exceeds the 64 MiB cleaning limit');
            }
            result = extractor.extractMany(parseRecords(fs.readFileSync(source, 'utf8')), {
                compare: args.compare !== false,
            });
            sourceLabel = fileSystem.relative(source);
            requestedOutput = args.outputPath || defaultOutputPath(fileSystem, source);
            if (path.resolve(fileSystem.resolveForWrite(requestedOutput)) === path.resolve(source)) {
                throw new Error('outputPath must not overwrite the raw trajectory source');
            }

            const output = fileSystem.resolveForWrite(requestedOutput);
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
            return JSON.stringify({
                ok: true,
                sourceType,
                source: sourceLabel,
                outputPath: fileSystem.relative(output),
                summary: resultSummary(result),
                comparison: result.comparison,
            }, null, 2);
        } catch (error) {
            const formatted = formatCapabilityError(fileSystem, error, 'Trajectory extraction failed');
            try { return JSON.stringify(JSON.parse(formatted), null, 2); }
            catch { return JSON.stringify({ ok: false, error: formatted }, null, 2); }
        }
    };
}

const handler = createHandler();

module.exports = {
    definition,
    handler,
    prompt,
    capabilities,
    createHandler,
    parseRecords,
    defaultOutputPath,
    defaultAuditOutput,
};
