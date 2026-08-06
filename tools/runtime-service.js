function requireRuntimeService(context, name) {
    const service = context && typeof context.getService === 'function'
        ? context.getService(name)
        : null;
    if (!service) throw new Error(`Runtime service is unavailable: ${name}`);
    return service;
}

function formatServiceError(service, error, fallbackLabel) {
    if (service && typeof service.formatError === 'function') {
        return service.formatError(error, fallbackLabel);
    }
    return `${fallbackLabel}: ${error instanceof Error ? error.message : String(error)}`;
}

module.exports = { requireRuntimeService, formatServiceError };
