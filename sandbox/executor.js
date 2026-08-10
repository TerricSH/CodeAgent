const { DockerClient } = require('./docker-client');
const { clampTimeout, buildRunArgs } = require('./policy');

const DIAGNOSTIC_OPTIONS = Object.freeze({
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
});

function cleanResult(result) {
    return {
        ok: result.exitCode === 0 && !result.timedOut && !result.error,
        exitCode: result.exitCode,
        signal: result.signal || null,
        timedOut: Boolean(result.timedOut),
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        truncated: Boolean(result.truncated),
        error: result.error || null,
        errorCode: result.errorCode || null,
        durationMs: result.durationMs,
    };
}

class DockerSandboxExecutor {
    constructor({ config, session, client } = {}) {
        if (!config) throw new Error('Docker sandbox config is required');
        this.config = config;
        this.session = String(session || 'anonymous');
        this.client = client || new DockerClient({ command: config.command });
        this.activeContainers = new Set();
    }

    async status() {
        const version = await this.client.version(DIAGNOSTIC_OPTIONS);
        const available = !version.error && version.exitCode === 0;
        let imageReady = false;
        let imageId = null;

        if (available) {
            const image = await this.client.inspectImage(this.config.image, DIAGNOSTIC_OPTIONS);
            imageReady = image.exitCode === 0 && !image.error;
            imageId = imageReady ? (image.stdout || '').trim() : null;
        }

        return {
            available,
            version: available ? (version.stdout || '').trim() : null,
            imageReady,
            image: this.config.image,
            imageId,
            error: available ? null : (version.error || version.stderr || 'Docker Engine is unavailable'),
        };
    }

    async execute({ command, timeoutMs, workspace, containerName } = {}) {
        const normalizedCommand = typeof command === 'string' ? command.trim() : '';
        if (!normalizedCommand) throw new Error('command is required');
        if (normalizedCommand.length > 32768) {
            throw new Error('command exceeds the 32768 character limit');
        }
        if (typeof workspace !== 'string' || !workspace) {
            throw new Error('workspace is required');
        }
        if (typeof containerName !== 'string' || !containerName) {
            throw new Error('containerName is required');
        }

        const dockerArgs = buildRunArgs({
            config: this.config,
            containerName,
            session: this.session,
            workspace,
            command: normalizedCommand,
        });

        this.activeContainers.add(containerName);
        let result;
        try {
            result = await this.client.run(dockerArgs, {
                timeoutMs: clampTimeout(timeoutMs, this.config),
                maxOutputBytes: this.config.maxOutputBytes,
            });
        } finally {
            this.activeContainers.delete(containerName);
        }

        if (result.timedOut) {
            await this.client.removeContainer(containerName, DIAGNOSTIC_OPTIONS);
        }
        return cleanResult(result);
    }

    async dispose() {
        const names = [...this.activeContainers];
        await Promise.all(names.map(name => this.client.removeContainer(name, DIAGNOSTIC_OPTIONS)));
        this.activeContainers.clear();
    }
}

module.exports = { DockerSandboxExecutor, cleanResult, DIAGNOSTIC_OPTIONS };
