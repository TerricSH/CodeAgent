const path = require('node:path');
const { loadImages, publicImageMetadata } = require('./image-file');
const { normalizeCriteria, normalizeVerification } = require('./verification');
const { loadPrompt, loadPromptTemplate } = require('../../prompts/loader');

const SYSTEM_PROMPT = loadPrompt(path.join(__dirname, 'prompts', 'system.md'));
const ANALYZE_USER_PROMPT = loadPrompt(path.join(__dirname, 'prompts', 'analyze-user.md'));
const renderVerifyUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'verify-user.md'));
const renderImageLabel = loadPromptTemplate(path.join(__dirname, 'prompts', 'image-label.md'));

function boundedText(value, fallback, maxChars) {
    if (value == null || String(value).trim() === '') return fallback;
    const text = String(value).trim();
    if (text.length > maxChars) throw new Error(`Inspection prompt exceeds ${maxChars} characters`);
    return text;
}

function imageContent(images, detail) {
    const content = [];
    images.forEach((image, index) => {
        content.push({
            type: 'text',
            text: renderImageLabel({ index: index + 1, path: image.path }),
        });
        content.push({
            type: 'image_url',
            image_url: { url: image.dataUrl, detail },
        });
    });
    return content;
}

class ImageInspectionService {
    constructor(config, provider) {
        this.config = config;
        this.provider = provider;
    }

    status() {
        return {
            ...this.provider.status(),
            acceptedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
            maxImages: this.config.maxImages,
            maxImageBytes: this.config.maxImageBytes,
            maxTotalImageBytes: this.config.maxTotalImageBytes,
            dataHandling: 'Images are sent to the configured external vision API only when analyze or verify is called.',
        };
    }

    async analyze(args, fileSystem) {
        const images = loadImages(args.imagePaths, fileSystem, this.config);
        const question = boundedText(
            args.question,
            ANALYZE_USER_PROMPT,
            8000
        );
        const detail = ['auto', 'low', 'high'].includes(args.detail) ? args.detail : 'high';
        const response = await this.provider.complete([
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: question },
                    ...imageContent(images, detail),
                ],
            },
        ]);
        return {
            ok: true,
            action: 'analyze',
            model: response.model,
            trust: 'untrusted-external-model-output',
            images: images.map(publicImageMetadata),
            analysis: response.content,
            usage: response.usage,
        };
    }

    async verify(args, fileSystem) {
        const criteria = normalizeCriteria(args.criteria);
        const images = loadImages(args.imagePaths, fileSystem, this.config);
        const detail = ['auto', 'low', 'high'].includes(args.detail) ? args.detail : 'high';
        const request = renderVerifyUser({
            criteria: JSON.stringify(
                criteria.map((criterion, criterionIndex) => ({ criterionIndex, criterion })),
                null,
                2
            ),
        });
        const response = await this.provider.complete([
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: request },
                    ...imageContent(images, detail),
                ],
            },
        ]);
        return {
            ok: true,
            action: 'verify',
            model: response.model,
            trust: 'untrusted-external-model-output',
            images: images.map(publicImageMetadata),
            verification: normalizeVerification(response.content, criteria, args.minConfidence),
            usage: response.usage,
        };
    }
}

module.exports = { ImageInspectionService, SYSTEM_PROMPT, imageContent };
