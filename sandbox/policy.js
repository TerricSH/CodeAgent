const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
    command: 'docker',
    image: 'codeagent-sandbox:local',
    timeoutMs: 30000,
    maxTimeoutMs: 120000,
    maxOutputBytes: 1024 * 1024,
    memory: '512m',
    memoryReservation: '128m',
    cpus: '1',
    pidsLimit: 128,
    tmpfsSize: '64m',
    network: 'none',
    maxActive: 8,
    engineMemoryFraction: 0.75,
    writableLayerSize: '1g',
    diskHighWatermark: 0.85,
});

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boundedFraction(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function byteSize(value) {
    const match = String(value || '').trim().toLowerCase()
        .match(/^(\d+(?:\.\d+)?)([kmgt]?)(?:i?b)?$/);
    if (!match) return null;
    const units = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
    return Number(match[1]) * units[match[2]];
}

function validatedSize(value, fallback, label) {
    const normalized = String(
        value === undefined || value === null || value === '' ? fallback : value
    );
    if (!Number.isFinite(byteSize(normalized)) || byteSize(normalized) <= 0) {
        throw new Error(`${label} must be a positive byte size`);
    }
    return normalized;
}

function sessionKey(sessionId) {
    return crypto
        .createHash('sha256')
        .update(String(sessionId || 'anonymous'))
        .digest('hex')
        .slice(0, 16);
}

function defaultContainerUser() {
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
        return `${process.getuid()}:${process.getgid()}`;
    }
    return '10001:10001';
}

function normalizeSandboxConfig(config = {}) {
    const sandboxRoot = path.resolve(
        config.sandboxRoot || path.join(process.cwd(), '.code', 'sandboxes')
    );
    if (sandboxRoot.includes(',')) throw new Error('Docker sandbox root cannot contain commas');

    const memory = validatedSize(config.memory, DEFAULTS.memory, 'Sandbox memory');
    const memoryReservation = validatedSize(
        config.memoryReservation,
        DEFAULTS.memoryReservation,
        'Sandbox memory reservation'
    );
    if (byteSize(memoryReservation) > byteSize(memory)) {
        throw new Error('Sandbox memory reservation cannot exceed its hard memory limit');
    }

    return Object.freeze({
        command: String(config.command || DEFAULTS.command),
        image: String(config.image || DEFAULTS.image),
        sandboxRoot,
        timeoutMs: positiveInteger(config.timeoutMs, DEFAULTS.timeoutMs),
        maxTimeoutMs: positiveInteger(config.maxTimeoutMs, DEFAULTS.maxTimeoutMs),
        maxOutputBytes: positiveInteger(config.maxOutputBytes, DEFAULTS.maxOutputBytes),
        memory,
        memoryReservation,
        cpus: String(config.cpus || DEFAULTS.cpus),
        pidsLimit: positiveInteger(config.pidsLimit, DEFAULTS.pidsLimit),
        tmpfsSize: validatedSize(config.tmpfsSize, DEFAULTS.tmpfsSize, 'Sandbox tmpfs size'),
        network: config.network === 'bridge' ? 'bridge' : DEFAULTS.network,
        user: String(config.user || defaultContainerUser()),
        maxActive: positiveInteger(config.maxActive, DEFAULTS.maxActive),
        engineMemoryFraction: boundedFraction(
            config.engineMemoryFraction,
            DEFAULTS.engineMemoryFraction
        ),
        writableLayerSize: validatedSize(
            config.writableLayerSize,
            DEFAULTS.writableLayerSize,
            'Sandbox writable layer size'
        ),
        diskHighWatermark: boundedFraction(
            config.diskHighWatermark,
            DEFAULTS.diskHighWatermark
        ),
    });
}

function clampTimeout(value, config) {
    const requested = positiveInteger(value, config.timeoutMs);
    return Math.min(requested, config.maxTimeoutMs);
}

function buildPersistentContainerArgs({ config, containerName, session, image }) {
    return [
        'container', 'create',
        '--name', containerName,
        '--label', 'com.codeagent.sandbox=true',
        '--label', `com.codeagent.session=${session}`,
        '--network', config.network,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', String(config.pidsLimit),
        '--memory', config.memory,
        '--memory-reservation', config.memoryReservation,
        '--memory-swap', config.memory,
        '--cpus', config.cpus,
        '--storage-opt', `size=${config.writableLayerSize}`,
        '--user', config.user,
        '--env', 'HOME=/tmp',
        '--tmpfs', `/tmp:rw,nosuid,nodev,size=${config.tmpfsSize}`,
        '--workdir', '/workspace',
        image,
        '/bin/sh', '-lc', 'while :; do sleep 3600; done',
    ];
}

module.exports = {
    DEFAULTS,
    positiveInteger,
    boundedFraction,
    byteSize,
    validatedSize,
    sessionKey,
    normalizeSandboxConfig,
    clampTimeout,
    buildPersistentContainerArgs,
};
