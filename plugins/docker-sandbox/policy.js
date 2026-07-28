const path = require('path');
const crypto = require('crypto');

const DEFAULTS = Object.freeze({
    command: 'docker',
    image: 'codeagent-sandbox:local',
    timeoutMs: 30000,
    maxTimeoutMs: 120000,
    maxOutputBytes: 1024 * 1024,
    memory: '512m',
    cpus: '1',
    pidsLimit: 128,
    tmpfsSize: '64m',
    network: 'none',
});

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
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

function normalizeConfig(config = {}) {
    const root = path.resolve(config.sandboxRoot || path.join(process.cwd(), '.code', 'sandboxes'));
    if (root.includes(',')) {
        throw new Error('Docker sandbox root cannot contain commas');
    }

    return Object.freeze({
        command: String(config.command || DEFAULTS.command),
        image: String(config.image || DEFAULTS.image),
        sandboxRoot: root,
        timeoutMs: positiveInteger(config.timeoutMs, DEFAULTS.timeoutMs),
        maxTimeoutMs: positiveInteger(config.maxTimeoutMs, DEFAULTS.maxTimeoutMs),
        maxOutputBytes: positiveInteger(config.maxOutputBytes, DEFAULTS.maxOutputBytes),
        memory: String(config.memory || DEFAULTS.memory),
        cpus: String(config.cpus || DEFAULTS.cpus),
        pidsLimit: positiveInteger(config.pidsLimit, DEFAULTS.pidsLimit),
        tmpfsSize: String(config.tmpfsSize || DEFAULTS.tmpfsSize),
        network: config.network === 'bridge' ? 'bridge' : DEFAULTS.network,
        user: String(config.user || defaultContainerUser()),
    });
}

function clampTimeout(value, config) {
    const requested = positiveInteger(value, config.timeoutMs);
    return Math.min(requested, config.maxTimeoutMs);
}

function buildRunArgs({ config, containerName, session, workspace, command }) {
    return [
        'container', 'run',
        '--rm',
        '--pull', 'never',
        '--name', containerName,
        '--label', 'com.codeagent.sandbox=true',
        '--label', `com.codeagent.session=${session}`,
        '--network', config.network,
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', String(config.pidsLimit),
        '--memory', config.memory,
        '--memory-swap', config.memory,
        '--cpus', config.cpus,
        '--user', config.user,
        '--env', 'HOME=/tmp',
        '--tmpfs', `/tmp:rw,nosuid,nodev,size=${config.tmpfsSize}`,
        '--mount', `type=bind,source=${workspace},target=/workspace`,
        '--workdir', '/workspace',
        config.image,
        '/bin/sh', '-lc', command,
    ];
}

module.exports = {
    DEFAULTS,
    normalizeConfig,
    sessionKey,
    clampTimeout,
    buildRunArgs,
};
