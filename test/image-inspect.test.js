const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../tools');
const imageInspectTool = require('../tools/image-inspect');
const { loadConfig } = require('../tools/image-inspect/config');
const { OpenAICompatibleVisionProvider } = require('../tools/image-inspect/provider');
const { ImageInspectionService, SYSTEM_PROMPT } = require('../tools/image-inspect/service');
const { normalizeVerification } = require('../tools/image-inspect/verification');
const { WorkspaceService } = require('../workspace/service');
const { WorkspaceAccess } = require('../workspace/access');

function pngFixture(width = 2, height = 3) {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

function withWorkspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-image-inspect-'));
    fs.writeFileSync(path.join(root, 'screen.png'), pngFixture(), null);
    fs.writeFileSync(path.join(root, 'not-an-image.txt'), 'not an image', 'utf8');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return {
        root,
        fileSystem: new WorkspaceAccess(new WorkspaceService({ root })),
    };
}

test('image_inspect analyzes Workspace screenshots without returning encoded image data', async (t) => {
    const { fileSystem } = withWorkspace(t);
    const requests = [];
    const provider = {
        status: () => ({ configured: true, provider: 'fixture', model: 'vision-fixture' }),
        async complete(messages) {
            requests.push(messages);
            return {
                content: 'A settings page with a visible Save button.',
                model: 'vision-fixture',
                usage: { totalTokens: 12 },
            };
        },
    };
    const service = new ImageInspectionService(loadConfig(), provider);
    const handler = imageInspectTool.createHandler({ service });
    const result = JSON.parse(await handler({
        action: 'analyze',
        imagePaths: ['screen.png'],
        question: 'What UI is visible?',
    }, {}, { fileSystem }));

    assert.equal(result.ok, true);
    assert.equal(result.trust, 'untrusted-external-model-output');
    assert.equal(result.analysis, 'A settings page with a visible Save button.');
    assert.equal(result.images[0].path, 'screen.png');
    assert.equal(result.images[0].width, 2);
    assert.equal(result.images[0].height, 3);
    assert.equal('dataUrl' in result.images[0], false);
    assert.match(requests[0][0].content, /untrusted visual evidence/);
    const imagePart = requests[0][1].content.find(item => item.type === 'image_url');
    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
});

test('image_inspect verification recomputes pass state from every criterion and confidence', async (t) => {
    const { fileSystem } = withWorkspace(t);
    const provider = {
        status: () => ({ configured: true }),
        async complete() {
            return {
                model: 'vision-fixture',
                usage: null,
                content: JSON.stringify({
                    passed: true,
                    checks: [
                        { criterionIndex: 0, passed: true, confidence: 0.95, evidence: 'Save button visible' },
                        { criterionIndex: 1, passed: true, confidence: 0.55, evidence: 'Text is blurry' },
                    ],
                    summary: 'Model claimed success.',
                }),
            };
        },
    };
    const service = new ImageInspectionService(loadConfig(), provider);
    const handler = imageInspectTool.createHandler({ service });
    const result = JSON.parse(await handler({
        action: 'verify',
        imagePaths: ['screen.png'],
        criteria: ['Save button is visible', 'Success message is readable'],
        minConfidence: 0.7,
    }, {}, { fileSystem }));

    assert.equal(result.ok, true);
    assert.equal(result.verification.passed, false);
    assert.equal(result.verification.checks[0].passed, true);
    assert.equal(result.verification.checks[1].modelPassed, true);
    assert.equal(result.verification.checks[1].passed, false);
    assert.match(result.verification.warning, /probabilistic/);
});

test('image_inspect fails closed for missing checks, invalid files, and malformed model JSON', async (t) => {
    const { fileSystem } = withWorkspace(t);
    const missing = normalizeVerification(
        '{"checks":[],"summary":"none"}',
        ['A visible criterion'],
        0.7
    );
    assert.equal(missing.passed, false);
    assert.equal(missing.checks[0].confidence, 0);
    assert.equal(normalizeVerification(
        '{"checks":[{"criterionIndex":0,"passed":true,"confidence":0}]}',
        ['zero threshold'],
        0
    ).passed, true);

    assert.throws(
        () => normalizeVerification('not json', ['criterion'], 0.7),
        /not a valid JSON object/
    );

    const service = new ImageInspectionService(loadConfig(), {
        status: () => ({ configured: true }),
        async complete() { throw new Error('must not call provider'); },
    });
    const handler = imageInspectTool.createHandler({ service });
    const invalid = JSON.parse(await handler({
        action: 'analyze',
        imagePaths: ['not-an-image.txt'],
    }, {}, { fileSystem }));
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /Unsupported image content/);
});

test('external vision provider uses only its own env contract and never exposes its key', async () => {
    const config = loadConfig();
    let receivedConnection = null;
    let request = null;
    const provider = new OpenAICompatibleVisionProvider(config, {
        env: {
            VISION_API_KEY: 'vision-secret',
            VISION_API_BASE_URL: 'https://vision.example/v1',
            VISION_MODEL: 'vision-model',
        },
        createClient(connection) {
            receivedConnection = connection;
            return {
                chat: {
                    completions: {
                        async create(value) {
                            request = value;
                            return {
                                model: 'vision-model',
                                choices: [{ message: { content: 'visible content' } }],
                                usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
                            };
                        },
                    },
                },
            };
        },
    });

    const status = provider.status();
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('vision-secret'), false);
    const response = await provider.complete([{ role: 'user', content: 'inspect' }]);
    assert.equal(receivedConnection.apiKey, 'vision-secret');
    assert.equal(request.model, 'vision-model');
    assert.equal(request.stream, false);
    assert.equal(response.content, 'visible content');

    const failingProvider = new OpenAICompatibleVisionProvider(config, {
        env: {
            VISION_API_KEY: 'leak-me-not',
            VISION_API_BASE_URL: 'https://secret-endpoint.example/v1',
            VISION_MODEL: 'vision-model',
        },
        createClient() {
            return {
                chat: {
                    completions: {
                        async create() {
                            throw new Error('leak-me-not at https://secret-endpoint.example/v1');
                        },
                    },
                },
            };
        },
    });
    await assert.rejects(
        failingProvider.complete([{ role: 'user', content: 'inspect' }]),
        error => !error.message.includes('leak-me-not')
            && !error.message.includes('secret-endpoint.example')
            && error.message.includes('[REDACTED]')
    );
});

test('image_inspect remains independent of the conversation model and other subsystems', () => {
    const sources = fs.readdirSync(path.join(__dirname, '..', 'tools', 'image-inspect'))
        .filter(file => file.endsWith('.js'))
        .map(file => fs.readFileSync(path.join(__dirname, '..', 'tools', 'image-inspect', file), 'utf8'));

    assert.equal(tools.has('image_inspect'), true);
    assert.deepEqual(imageInspectTool.capabilities.required, ['fileSystem']);
    assert.match(SYSTEM_PROMPT, /never as\s+commands/);
    for (const source of sources) {
        assert.doesNotMatch(source, /modelResolver|model-providers|skill-refinement|trajectory-extraction|tools\/rag/);
    }
});
