const fs = require('node:fs');
const path = require('node:path');
const { TrajectoryExtractor } = require('../../trajectory-extraction');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'trajectory_extract',
        description: 'Clean a saved JSON/JSONL agent trajectory file into source-addressable spans and outcome signals.',
        parameters: {
            type: 'object',
            properties: {
                sourcePath: {
                    type: 'string',
                    description: 'Saved JSONL or JSON trajectory file inside the current Workspace.',
                },
                outputPath: {
                    type: 'string',
                    description: 'Optional cleaned JSON destination. Defaults beside the source file.',
                },
                compare: {
                    type: 'boolean',
                    description: 'Return an evidence-linked comparison. Defaults to true.',
                },
            },
            required: ['sourcePath'],
        },
    },
};

const capabilities = { required: ['fileSystem'] };

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
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
        }
    });
}

function defaultOutputPath(fileSystem, source) {
    const relativeSource = fileSystem.relative(source);
    const extension = path.extname(relativeSource);
    const base = extension ? relativeSource.slice(0, -extension.length) : relativeSource;
    return `${base}.cleaned.json`;
}

function resultSummary(result) {
    const spans = result.trajectories.reduce((sum, item) => sum + item.summary.totalSpans, 0);
    const toolCalls = result.trajectories.reduce((sum, item) => sum + item.summary.toolCalls, 0);
    const failedToolCalls = result.trajectories.reduce(
        (sum, item) => sum + item.summary.failedToolCalls,
        0
    );
    return {
        trajectoryCount: result.trajectories.length,
        spans,
        toolCalls,
        failedToolCalls,
    };
}

function createHandler(options = {}) {
    const extractor = options.extractor || new TrajectoryExtractor(options.extractorOptions);
    return function handler(args = {}, context, injectedCapabilities = {}) {
        let fileSystem = null;
        try {
            fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
            const source = fileSystem.resolveExisting(args.sourcePath, { type: 'file' });
            const stat = fs.statSync(source);
            if (stat.size > 64 * 1024 * 1024) {
                throw new Error('Trajectory source exceeds the 64 MiB cleaning limit');
            }
            const records = parseRecords(fs.readFileSync(source, 'utf8'));
            const result = extractor.extractMany(records, { compare: args.compare !== false });
            const requestedOutput = args.outputPath || defaultOutputPath(fileSystem, source);
            const output = fileSystem.resolveForWrite(requestedOutput);
            if (path.resolve(output) === path.resolve(source)) {
                throw new Error('outputPath must not overwrite the raw trajectory source');
            }
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
            return JSON.stringify({
                ok: true,
                sourcePath: fileSystem.relative(source),
                outputPath: fileSystem.relative(output),
                summary: resultSummary(result),
                comparison: result.comparison,
            }, null, 2);
        } catch (error) {
            const formatted = formatCapabilityError(fileSystem, error, 'Trajectory extraction failed');
            try {
                const detail = JSON.parse(formatted);
                return JSON.stringify(detail, null, 2);
            } catch {
                return JSON.stringify({ ok: false, error: formatted }, null, 2);
            }
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
};
