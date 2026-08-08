const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SUPPORTED_PROVIDER = 'openai-compatible';

function positiveInteger(value, fallback, max) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function loadConfig(configPath = CONFIG_PATH) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Image Inspect configuration must be an object');
    }
    if (parsed.schemaVersion !== 1) {
        throw new Error(`Unsupported Image Inspect schemaVersion: ${parsed.schemaVersion}`);
    }
    if (parsed.provider !== SUPPORTED_PROVIDER) {
        throw new Error(`Unsupported Image Inspect provider: ${parsed.provider}`);
    }
    for (const field of ['apiKeyEnv', 'baseURLEnv', 'modelEnv']) {
        if (typeof parsed[field] !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(parsed[field])) {
            throw new Error(`Image Inspect ${field} must name an environment variable`);
        }
    }
    return Object.freeze({
        schemaVersion: 1,
        provider: parsed.provider,
        apiKeyEnv: parsed.apiKeyEnv,
        baseURLEnv: parsed.baseURLEnv,
        modelEnv: parsed.modelEnv,
        timeoutMs: positiveInteger(parsed.timeoutMs, 120000, 300000),
        maxImageBytes: positiveInteger(parsed.maxImageBytes, 20 * 1024 * 1024, 50 * 1024 * 1024),
        maxTotalImageBytes: positiveInteger(
            parsed.maxTotalImageBytes,
            40 * 1024 * 1024,
            100 * 1024 * 1024
        ),
        maxImages: positiveInteger(parsed.maxImages, 8, 16),
        maxOutputTokens: positiveInteger(parsed.maxOutputTokens, 4096, 16384),
    });
}

function envValue(env, name) {
    const value = env && typeof env[name] === 'string' ? env[name].trim() : '';
    return value || null;
}

function resolveConnection(config, env = process.env) {
    const apiKey = envValue(env, config.apiKeyEnv);
    const baseURL = envValue(env, config.baseURLEnv);
    const model = envValue(env, config.modelEnv);
    const missing = [];
    if (!apiKey) missing.push(config.apiKeyEnv);
    if (!baseURL) missing.push(config.baseURLEnv);
    if (!model) missing.push(config.modelEnv);
    if (baseURL) {
        let parsed;
        try { parsed = new URL(baseURL); } catch { parsed = null; }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`${config.baseURLEnv} must be an HTTP(S) URL`);
        }
    }
    return Object.freeze({ apiKey, baseURL, model, missing });
}

module.exports = {
    CONFIG_PATH,
    SUPPORTED_PROVIDER,
    loadConfig,
    resolveConnection,
};
