function formatCapabilityError(capability, error, fallbackLabel) {
    if (capability && typeof capability.formatError === 'function') {
        return capability.formatError(error, fallbackLabel);
    }
    return `${fallbackLabel}: ${error instanceof Error ? error.message : String(error)}`;
}

module.exports = { formatCapabilityError };
