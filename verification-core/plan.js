const crypto = require('node:crypto');

const CHECK_TYPES = Object.freeze(['command', 'file', 'json']);
const MAX_CHECKS = 64;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, stableValue(value[key])])
        );
    }
    return value;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function normalizeString(value, label, max = 32768) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    const normalized = value.trim();
    if (normalized.length > max) throw new TypeError(`${label} exceeds ${max} characters`);
    return normalized;
}

function normalizeCommand(check) {
    return {
        id: check.id,
        type: check.type,
        command: normalizeString(check.command, `check "${check.id}" command`),
        timeoutMs: Number.isInteger(check.timeoutMs)
            ? Math.min(Math.max(check.timeoutMs, 100), 120000)
            : 30000,
    };
}

function normalizeFile(check) {
    const normalized = {
        id: check.id,
        type: check.type,
        path: normalizeString(check.path, `check "${check.id}" path`, 4096),
    };
    if (check.exists !== undefined) normalized.exists = Boolean(check.exists);
    else normalized.exists = true;
    if (check.kind !== undefined) {
        if (!['file', 'directory'].includes(check.kind)) {
            throw new TypeError(`check "${check.id}" kind must be file or directory`);
        }
        normalized.kind = check.kind;
    }
    if (check.nonEmpty !== undefined) normalized.nonEmpty = Boolean(check.nonEmpty);
    if (check.contains !== undefined) {
        normalized.contains = normalizeString(check.contains, `check "${check.id}" contains`, 16384);
    }
    if (check.matches !== undefined) {
        normalized.matches = normalizeString(check.matches, `check "${check.id}" matches`, 4096);
        try { new RegExp(normalized.matches); } catch (error) {
            throw new TypeError(`check "${check.id}" matches is invalid: ${error.message}`);
        }
    }
    return normalized;
}

function normalizeJsonAssertion(assertion, checkId, index) {
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
        throw new TypeError(`check "${checkId}" assertions[${index}] must be an object`);
    }
    const pointer = assertion.pointer === ''
        ? ''
        : normalizeString(assertion.pointer, `check "${checkId}" assertions[${index}].pointer`, 4096);
    if (pointer !== '' && !pointer.startsWith('/')) {
        throw new TypeError(`check "${checkId}" assertions[${index}].pointer must be a JSON Pointer`);
    }
    const normalized = { pointer };
    if (assertion.exists !== undefined) normalized.exists = Boolean(assertion.exists);
    else normalized.exists = true;
    if (assertion.valueType !== undefined) {
        if (!['null', 'boolean', 'number', 'string', 'array', 'object'].includes(assertion.valueType)) {
            throw new TypeError(`check "${checkId}" assertion valueType is invalid`);
        }
        normalized.valueType = assertion.valueType;
    }
    if (Object.prototype.hasOwnProperty.call(assertion, 'equals')) normalized.equals = assertion.equals;
    return normalized;
}

function normalizeJson(check) {
    if (!Array.isArray(check.assertions) || check.assertions.length === 0) {
        throw new TypeError(`check "${check.id}" assertions must be a non-empty array`);
    }
    return {
        id: check.id,
        type: check.type,
        path: normalizeString(check.path, `check "${check.id}" path`, 4096),
        assertions: check.assertions.map((item, index) => normalizeJsonAssertion(item, check.id, index)),
    };
}

function assertJsonValue(value, label, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') throw new TypeError(`${label} must contain only JSON values`);
    if (seen.has(value)) throw new TypeError(`${label} must not contain circular values`);
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, seen));
    } else {
        for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${label}.${key}`, seen);
    }
    seen.delete(value);
}

function normalizeExtensionCheck(check) {
    const { id, type, ...configuration } = check;
    assertJsonValue(configuration, `check "${id}" configuration`);
    return { id, type, ...JSON.parse(JSON.stringify(configuration)) };
}

function normalizeCheck(check, index) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
        throw new TypeError(`checks[${index}] must be an object`);
    }
    const base = {
        ...check,
        id: normalizeString(check.id, `checks[${index}].id`, 128),
        type: normalizeString(check.type, `checks[${index}].type`, 64),
    };
    if (base.type === 'command') return normalizeCommand(base);
    if (base.type === 'file') return normalizeFile(base);
    if (base.type === 'json') return normalizeJson(base);
    return normalizeExtensionCheck(base);
}

function createPlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Verification plan must be an object');
    }
    if (!Array.isArray(input.checks) || input.checks.length === 0) {
        throw new TypeError('Verification plan checks must be a non-empty array');
    }
    if (input.checks.length > MAX_CHECKS) throw new TypeError(`Verification plan exceeds ${MAX_CHECKS} checks`);
    const checks = input.checks.map(normalizeCheck);
    const ids = checks.map(check => check.id);
    if (new Set(ids).size !== ids.length) throw new TypeError('Verification check ids must be unique');
    const normalized = stableValue({ version: 1, checks });
    const canonical = JSON.stringify(normalized);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    return deepFreeze({ ...normalized, hash });
}

module.exports = { createPlan, stableValue, deepFreeze, assertJsonValue, CHECK_TYPES, MAX_CHECKS };
