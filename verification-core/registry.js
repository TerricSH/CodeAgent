class VerifierRegistry {
    constructor(providers = []) {
        this.providers = new Map();
        for (const provider of providers) this.register(provider);
    }

    register(provider) {
        if (!provider || typeof provider.type !== 'string' || !provider.type.trim()) {
            throw new TypeError('Verification provider must define a non-empty type');
        }
        if (typeof provider.verify !== 'function') {
            throw new TypeError(`Verification provider "${provider.type}" must implement verify()`);
        }
        if (this.providers.has(provider.type)) {
            throw new Error(`Duplicate verification provider: ${provider.type}`);
        }
        this.providers.set(provider.type, Object.freeze(provider));
        return provider;
    }

    get(type) {
        return this.providers.get(type) || null;
    }

    list() {
        return [...this.providers.keys()];
    }
}

module.exports = VerifierRegistry;
