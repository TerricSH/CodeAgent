function normalizeNames(owner, kind, names) {
    if (names === undefined) return [];
    if (!Array.isArray(names)) {
        throw new TypeError(`${owner} capabilities.${kind} must be an array`);
    }
    const normalized = names.map((name) => {
        if (typeof name !== 'string' || !name.trim()) {
            throw new TypeError(`${owner} capabilities.${kind} must contain non-empty names`);
        }
        return name.trim();
    });
    if (new Set(normalized).size !== normalized.length) {
        throw new TypeError(`${owner} capabilities.${kind} contains duplicate names`);
    }
    return normalized;
}

function validateCapabilityDeclaration(owner, declaration = {}) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        throw new TypeError(`${owner} capabilities must be an object`);
    }
    const required = normalizeNames(owner, 'required', declaration.required);
    const optional = normalizeNames(owner, 'optional', declaration.optional);
    const overlap = required.filter(name => optional.includes(name));
    if (overlap.length > 0) {
        throw new TypeError(`${owner} declares capabilities as both required and optional: ${overlap.join(', ')}`);
    }
    return Object.freeze({
        required: Object.freeze(required),
        optional: Object.freeze(optional),
    });
}

function selectCapabilities(available, declaration, owner, options = {}) {
    const source = available && typeof available === 'object' ? available : {};
    const normalized = validateCapabilityDeclaration(owner, declaration);
    const missing = normalized.required.filter(
        name => !Object.prototype.hasOwnProperty.call(source, name) || source[name] == null
    );
    if (missing.length > 0 && options.allowMissing !== true) {
        throw new Error(`${owner} requires unavailable runtime capabilities: ${missing.join(', ')}`);
    }

    const selected = {};
    for (const name of [...normalized.required, ...normalized.optional]) {
        if (Object.prototype.hasOwnProperty.call(source, name) && source[name] != null) {
            selected[name] = source[name];
        }
    }
    return Object.freeze(selected);
}

function requireCapability(capabilities, name) {
    const capability = capabilities && Object.prototype.hasOwnProperty.call(capabilities, name)
        ? capabilities[name]
        : null;
    if (!capability) throw new Error(`Runtime capability is unavailable: ${name}`);
    return capability;
}

module.exports = {
    validateCapabilityDeclaration,
    selectCapabilities,
    requireCapability,
};
