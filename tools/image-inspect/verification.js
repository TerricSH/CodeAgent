function truncate(value, maxChars = 4000) {
    const text = value == null ? '' : String(value);
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[truncated]`;
}

function stripFence(value) {
    const text = String(value || '').trim();
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    return (fenced ? fenced[1] : text).trim();
}

function parseJsonObject(value) {
    const text = stripFence(value);
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                const parsed = JSON.parse(text.slice(start, end + 1));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch {
                // The caller receives a stable invalid-response error below.
            }
        }
    }
    throw new Error('Vision verification response is not a valid JSON object');
}

function normalizeCriteria(criteria) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
        throw new TypeError('verify requires a non-empty criteria array');
    }
    if (criteria.length > 30) throw new Error('verify accepts at most 30 criteria');
    return criteria.map((value, index) => {
        if (typeof value !== 'string' || !value.trim()) {
            throw new TypeError(`criteria[${index}] must be a non-empty string`);
        }
        if (value.length > 2000) throw new Error(`criteria[${index}] exceeds 2000 characters`);
        return value.trim();
    });
}

function confidence(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(Math.max(number, 0), 1);
}

function normalizeVerification(raw, criteria, minConfidence = 0.7) {
    const parsed = parseJsonObject(raw);
    const sourceChecks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const requestedThreshold = Number(minConfidence);
    const threshold = Number.isFinite(requestedThreshold)
        ? Math.min(Math.max(requestedThreshold, 0), 1)
        : 0.7;
    const checks = criteria.map((criterion, criterionIndex) => {
        const source = sourceChecks.find(item => Number(item?.criterionIndex) === criterionIndex);
        const score = confidence(source?.confidence);
        const modelPassed = source?.passed === true;
        return {
            criterionIndex,
            criterion,
            passed: Boolean(source) && modelPassed && score >= threshold,
            modelPassed,
            confidence: score,
            evidence: source
                ? truncate(source.evidence || source.reason || '', 2000)
                : 'The model did not return a result for this criterion.',
        };
    });
    return {
        passed: checks.every(check => check.passed),
        minConfidence: threshold,
        checks,
        summary: truncate(parsed.summary || '', 4000),
        method: 'external-vision-model',
        warning: 'Visual model verification is probabilistic; review cited visible evidence for high-stakes decisions.',
    };
}

module.exports = {
    truncate,
    stripFence,
    parseJsonObject,
    normalizeCriteria,
    normalizeVerification,
};
