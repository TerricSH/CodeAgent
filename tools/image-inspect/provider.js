const OpenAI = require('openai');
const { resolveConnection } = require('./config');

function responseText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(item => item && (item.type === 'text' || typeof item.text === 'string'))
        .map(item => item.text || '')
        .join('\n');
}

function safeRequestError(error, connection) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [connection.apiKey, connection.baseURL]) {
        if (secret) message = message.split(secret).join('[REDACTED]');
    }
    if (message.length > 2000) message = `${message.slice(0, 2000)}...[truncated]`;
    return new Error(`Vision API request failed: ${message}`);
}

class OpenAICompatibleVisionProvider {
    constructor(config, dependencies = {}) {
        this.config = config;
        this.env = dependencies.env || process.env;
        this.createClient = dependencies.createClient || ((connection) => new OpenAI({
            apiKey: connection.apiKey,
            baseURL: connection.baseURL,
            timeout: config.timeoutMs,
            maxRetries: 1,
        }));
    }

    status() {
        const connection = resolveConnection(this.config, this.env);
        return {
            provider: this.config.provider,
            configured: connection.missing.length === 0,
            model: connection.model,
            missingEnvironmentVariables: connection.missing,
            apiKeyConfigured: Boolean(connection.apiKey),
            baseURLConfigured: Boolean(connection.baseURL),
        };
    }

    async complete(messages) {
        const connection = resolveConnection(this.config, this.env);
        if (connection.missing.length > 0) {
            throw new Error(`Image Inspect is not configured; missing: ${connection.missing.join(', ')}`);
        }
        let response;
        try {
            const client = this.createClient(connection);
            response = await client.chat.completions.create({
                model: connection.model,
                messages,
                temperature: 0,
                max_tokens: this.config.maxOutputTokens,
                stream: false,
            });
        } catch (error) {
            throw safeRequestError(error, connection);
        }
        const content = responseText(response?.choices?.[0]?.message?.content).trim();
        if (!content) throw new Error('Vision model returned an empty response');
        return {
            content,
            model: response.model || connection.model,
            usage: response.usage ? {
                promptTokens: response.usage.prompt_tokens ?? null,
                completionTokens: response.usage.completion_tokens ?? null,
                totalTokens: response.usage.total_tokens ?? null,
            } : null,
        };
    }
}

module.exports = { OpenAICompatibleVisionProvider, responseText, safeRequestError };
