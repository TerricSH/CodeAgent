const fs = require('node:fs');
const path = require('node:path');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');
const { loadConfig } = require('./config');
const { OpenAICompatibleVisionProvider } = require('./provider');
const { ImageInspectionService } = require('./service');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'image_inspect',
        description: 'Analyze or verify local screenshots with a separately configured external vision-model API.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'analyze', 'verify'],
                },
                imagePaths: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 8,
                    items: { type: 'string' },
                    description: 'Local screenshot/image paths inside the current Workspace.',
                },
                question: {
                    type: 'string',
                    description: 'Specific visual question for analyze.',
                },
                criteria: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 30,
                    items: { type: 'string' },
                    description: 'Visible conditions that every screenshot must satisfy for verify.',
                },
                minConfidence: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                    description: 'Minimum per-criterion confidence for verify; defaults to 0.7.',
                },
                detail: {
                    type: 'string',
                    enum: ['auto', 'low', 'high'],
                    description: 'Vision API image detail level; defaults to high.',
                },
            },
            required: ['action'],
        },
    },
};

const capabilities = { required: ['fileSystem'] };

function createService(options = {}) {
    const config = options.config || loadConfig(options.configPath);
    const provider = options.provider || new OpenAICompatibleVisionProvider(config, options);
    return new ImageInspectionService(config, provider);
}

function createHandler(options = {}) {
    return async function handler(args = {}, context, injectedCapabilities = {}) {
        let fileSystem = null;
        try {
            fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
            const service = options.service || createService(options);
            switch (args.action) {
                case 'status':
                    return JSON.stringify({ ok: true, ...service.status() }, null, 2);
                case 'analyze':
                    return JSON.stringify(await service.analyze(args, fileSystem), null, 2);
                case 'verify':
                    return JSON.stringify(await service.verify(args, fileSystem), null, 2);
                default:
                    throw new Error(`Unsupported Image Inspect action: ${args.action || '(missing)'}`);
            }
        } catch (error) {
            const formatted = formatCapabilityError(fileSystem, error, 'Image inspection failed');
            try {
                return JSON.stringify(JSON.parse(formatted), null, 2);
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
    createService,
    createHandler,
};
