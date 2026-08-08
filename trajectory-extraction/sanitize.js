const DEFAULT_LIMITS = Object.freeze({
    maxStringChars: 4000,
    maxArrayItems: 200,
    maxObjectKeys: 100,
    maxDepth: 8,
});

const SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|cookie|credential)/i;
const INLINE_SECRET = /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|cookie|credential)\s*[:=]\s*)([^\s,;"']+)/gi;

function truncateText(value, maxChars = DEFAULT_LIMITS.maxStringChars) {
    const text = value == null ? '' : String(value);
    const redacted = text.replace(INLINE_SECRET, '$1[REDACTED]');
    if (redacted.length <= maxChars) return redacted;
    return `${redacted.slice(0, maxChars)}...[truncated ${redacted.length - maxChars} chars]`;
}

function sanitizeValue(value, options = {}, depth = 0, seen = new WeakSet()) {
    const limits = { ...DEFAULT_LIMITS, ...options };
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return truncateText(value, limits.maxStringChars);
    if (typeof value === 'bigint') return String(value);
    if (depth >= limits.maxDepth) return '[max depth reached]';
    if (typeof value !== 'object') return truncateText(String(value), limits.maxStringChars);
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        const items = value
            .slice(0, limits.maxArrayItems)
            .map(item => sanitizeValue(item, limits, depth + 1, seen));
        if (value.length > limits.maxArrayItems) {
            items.push(`[truncated ${value.length - limits.maxArrayItems} items]`);
        }
        return items;
    }

    const result = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, limits.maxObjectKeys)) {
        result[key] = SENSITIVE_KEY.test(key)
            ? '[REDACTED]'
            : sanitizeValue(item, limits, depth + 1, seen);
    }
    if (entries.length > limits.maxObjectKeys) {
        result.__truncatedKeys = entries.length - limits.maxObjectKeys;
    }
    return result;
}

function parseAndSanitize(value, options) {
    if (typeof value !== 'string') return sanitizeValue(value, options);
    try {
        return sanitizeValue(JSON.parse(value), options);
    } catch {
        return sanitizeValue(value, options);
    }
}

module.exports = {
    DEFAULT_LIMITS,
    SENSITIVE_KEY,
    truncateText,
    sanitizeValue,
    parseAndSanitize,
};
