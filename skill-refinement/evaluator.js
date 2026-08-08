const crypto = require('node:crypto');
const { DockerClient } = require('../sandbox/docker-client');
const { sessionKey, clampTimeout, buildRunArgs } = require('../sandbox/policy');
const { ensureContainedDirectory } = require('./workspace');

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

class SandboxEvaluator {
    constructor(sessionId, config, dependencies = {}) {
        this.session = sessionKey(sessionId);
        this.config = config;
        this.client = dependencies.client || new DockerClient({ command: config.command });
        this._activeContainers = new Set();
    }

    async status() {
        const version = await this.client.version({ timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
        const available = !version.error && version.exitCode === 0;
        let imageReady = false;
        let imageId = null;
        if (available) {
            const image = await this.client.inspectImage(this.config.image, {
                timeoutMs: 5000,
                maxOutputBytes: 64 * 1024,
            });
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

    async execute(args, workspace, metadata) {
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!command) throw new Error('command is required');
        if (command.length > 32768) throw new Error('command exceeds the 32768 character limit');
        const realWorkspace = ensureContainedDirectory(
            this.config.sandboxRoot,
            workspace,
            'Skill Refinement rollout workspace'
        );
        const containerName = `codeagent-refine-${this.session}-${metadata.rolloutId}-${crypto.randomUUID().slice(0, 8)}`;
        const dockerArgs = buildRunArgs({
            config: this.config,
            containerName,
            session: this.session,
            workspace: realWorkspace,
            command,
        });
        this._activeContainers.add(containerName);
        let result;
        try {
            result = await this.client.run(dockerArgs, {
                timeoutMs: clampTimeout(args.timeoutMs, this.config),
                maxOutputBytes: this.config.maxOutputBytes,
            });
        } finally {
            this._activeContainers.delete(containerName);
        }
        if (result.timedOut) {
            await this.client.removeContainer(containerName, {
                timeoutMs: 5000,
                maxOutputBytes: 64 * 1024,
            });
        }
        return { ...cleanResult(result), ...metadata };
    }

    async dispose() {
        const names = [...this._activeContainers];
        await Promise.all(names.map(name => this.client.removeContainer(name, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        })));
        this._activeContainers.clear();
    }
}

module.exports = { SandboxEvaluator, cleanResult };
