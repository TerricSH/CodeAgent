function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function validateCollection(value, fallback) {
    const collection = String(value || fallback || 'global').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(collection)) {
        throw new Error('RAG collection must be 1-128 safe identifier characters');
    }
    return collection;
}

function safeString(value, max, label, required = false) {
    const text = value == null ? '' : String(value).trim();
    if (required && !text) throw new Error(`${label} is required`);
    if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return text || null;
}

function embeddingModel(provider) {
    const info = typeof provider.info === 'function' ? provider.info() : {};
    return info.model || provider.model || 'unknown';
}

module.exports = {
    boundedInteger,
    validateCollection,
    safeString,
    embeddingModel,
};
