function describeModel(model, requestedRef, source) {
    const info = typeof model.info === 'function' ? model.info() || {} : {};
    return Object.freeze({
        requestedRef: requestedRef || null,
        source,
        ref: info.ref || requestedRef || null,
        model: info.model || null,
        maxContextTokens: Number.isInteger(info.maxContextTokens)
            ? info.maxContextTokens
            : null,
    });
}

function validateRoleModel(role, model, method) {
    if (!model || typeof model[method] !== 'function') {
        throw new Error(`Skill Refinement ${role} model requires ${method}()`);
    }
    return model;
}

async function resolveRefinementModels({ suite, defaultModel, modelResolver }) {
    const cache = new Map();
    const resolveRole = async (role, requestedRef, method) => {
        let model;
        let source;
        if (requestedRef) {
            if (!modelResolver || typeof modelResolver.resolve !== 'function') {
                throw new Error(
                    `Skill Refinement suite requests ${role} model "${requestedRef}", `
                    + 'but modelResolver capability is unavailable'
                );
            }
            if (!cache.has(requestedRef)) {
                cache.set(requestedRef, Promise.resolve(modelResolver.resolve(requestedRef)));
            }
            model = await cache.get(requestedRef);
            source = 'suite';
        } else {
            model = defaultModel;
            source = 'current';
        }
        validateRoleModel(role, model, method);
        return Object.freeze({
            model,
            info: describeModel(model, requestedRef, source),
        });
    };

    const [template, reflection] = await Promise.all([
        resolveRole('template', suite.templateModel, 'chat'),
        resolveRole('reflection', suite.reflectionModel, 'complete'),
    ]);
    return Object.freeze({ template, reflection });
}

module.exports = { resolveRefinementModels, describeModel, validateRoleModel };
