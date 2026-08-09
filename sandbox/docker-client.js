const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function appendChunk(state, chunk, limit) {
    if (state.truncated || !chunk) return;
    const remaining = limit - state.bytes;
    if (remaining <= 0) {
        state.truncated = true;
        return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const kept = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    state.parts.push(kept);
    state.bytes += kept.length;
    if (kept.length < buffer.length) state.truncated = true;
}

function runProcess(file, args, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    const maxOutputBytes = options.maxOutputBytes || 1024 * 1024;
    const hasInput = typeof options.input === 'string' || Buffer.isBuffer(options.input);

    return new Promise((resolve) => {
        const startedAt = Date.now();
        const stdout = { parts: [], bytes: 0, truncated: false };
        const stderr = { parts: [], bytes: 0, truncated: false };
        let timedOut = false;
        let settled = false;
        let child;

        try {
            child = spawn(file, args, {
                cwd: options.cwd,
                env: options.env || process.env,
                windowsHide: true,
                stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
                shell: false,
            });
        } catch (error) {
            resolve({
                exitCode: null,
                signal: null,
                timedOut: false,
                stdout: '',
                stderr: '',
                truncated: false,
                error: error.message,
                errorCode: error.code || null,
                durationMs: Date.now() - startedAt,
            });
            return;
        }

        const finish = (exitCode, signal, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                exitCode,
                signal: signal || null,
                timedOut,
                stdout: Buffer.concat(stdout.parts).toString('utf8'),
                stderr: Buffer.concat(stderr.parts).toString('utf8'),
                truncated: stdout.truncated || stderr.truncated,
                error: error ? error.message : null,
                errorCode: error && error.code ? error.code : null,
                durationMs: Date.now() - startedAt,
            });
        };

        child.stdout.on('data', chunk => appendChunk(stdout, chunk, maxOutputBytes));
        child.stderr.on('data', chunk => appendChunk(stderr, chunk, maxOutputBytes));
        if (hasInput) {
            child.stdin.on('error', () => {});
            child.stdin.end(options.input);
        }
        child.on('error', error => finish(null, null, error));
        child.on('close', (code, signal) => finish(code, signal, null));

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        timer.unref?.();
    });
}

class DockerClient {
    constructor(options = {}) {
        this.command = options.command || 'docker';
        this.runner = options.runner || runProcess;
    }

    run(args, options = {}) {
        return this.runner(this.command, args, options);
    }

    version(options = {}) {
        return this.run(['version', '--format', '{{.Server.Version}}'], options);
    }

    inspectImage(image, options = {}) {
        return this.run(['image', 'inspect', image, '--format', '{{.Id}}'], options);
    }

    async engineInfo(options = {}) {
        const result = await this.run(['info', '--format', '{{json .}}'], options);
        if (result.error || result.exitCode !== 0) return null;
        try {
            const info = JSON.parse((result.stdout || '').trim());
            return {
                memoryBytes: Number(info.MemTotal) || null,
                dockerRootDir: info.DockerRootDir || null,
                driver: info.Driver || null,
            };
        } catch {
            return null;
        }
    }

    async diskUsage(options = {}) {
        const info = await this.engineInfo(options);
        if (!info || !info.dockerRootDir || typeof fs.statfsSync !== 'function') return null;
        try {
            const stat = fs.statfsSync(info.dockerRootDir);
            const total = Number(stat.blocks) * Number(stat.bsize);
            const available = Number(stat.bavail) * Number(stat.bsize);
            if (!Number.isFinite(total) || total <= 0) return null;
            return {
                totalBytes: total,
                availableBytes: available,
                fractionUsed: (total - available) / total,
            };
        } catch {
            return null;
        }
    }

    async buildSnapshotImage(spec, options = {}) {
        const baseImage = String(spec.baseImage || '');
        const user = String(spec.user || '10001:10001');
        if (!/^[a-zA-Z0-9._/@:-]+$/.test(baseImage)) {
            throw new Error('Snapshot base image reference is invalid');
        }
        if (!/^[a-zA-Z0-9_.:-]+$/.test(user)) throw new Error('Snapshot user is invalid');
        const context = path.resolve(spec.context);
        const token = crypto.randomUUID().replace(/-/g, '');
        const dockerfileName = `.codeagent-snapshot-${token}.Dockerfile`;
        const dockerfile = path.join(context, dockerfileName);
        const ignoreFile = `${dockerfile}.dockerignore`;
        const body = [
            `FROM ${baseImage}`,
            'USER 0',
            `COPY --chown=${user} . /workspace`,
            `USER ${user}`,
            'WORKDIR /workspace',
            'CMD ["/bin/sh", "-lc", "while :; do sleep 3600; done"]',
            '',
        ].join('\n');
        fs.writeFileSync(dockerfile, body, 'utf8');
        fs.writeFileSync(ignoreFile, `${dockerfileName}\n${dockerfileName}.dockerignore\n`, 'utf8');
        try {
            const result = await this.run([
                'image', 'build',
                '--pull=false',
                '--tag', spec.image,
                '--file', dockerfile,
                context,
            ], options);
            if (result.error || result.exitCode !== 0) {
                const error = new Error(
                    result.error || result.stderr || 'Docker snapshot build failed'
                );
                error.code = result.errorCode || 'SANDBOX_SNAPSHOT_BUILD_FAILED';
                error.result = result;
                throw error;
            }
            return result;
        } finally {
            fs.rmSync(dockerfile, { force: true });
            fs.rmSync(ignoreFile, { force: true });
        }
    }

    createContainer(args, options = {}) {
        return this.run(args, options);
    }

    startContainer(name, options = {}) {
        return this.run(['container', 'start', name], options);
    }

    stopContainer(name, options = {}) {
        return this.run(['container', 'stop', '--time', '1', name], options);
    }

    execContainer(name, command, options = {}) {
        return this.run(['container', 'exec', name, '/bin/sh', '-lc', command], options);
    }

    async inspectContainerState(name, options = {}) {
        const result = await this.run([
            'container', 'inspect', name, '--format', '{{json .State}}',
        ], options);
        if (result.error || result.exitCode !== 0) {
            return {
                oomKilled: false,
                error: result.error || result.stderr || 'Docker container inspection failed',
                result,
            };
        }
        try {
            const state = JSON.parse((result.stdout || '').trim());
            return {
                oomKilled: Boolean(state.OOMKilled),
                running: Boolean(state.Running),
                exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
            };
        } catch {
            return { oomKilled: false, error: 'Docker returned invalid container state', result };
        }
    }

    copyFromContainer(name, source, destination, options = {}) {
        return this.run(['container', 'cp', `${name}:${source}`, destination], options);
    }

    removeContainer(name, options = {}) {
        return this.run(['container', 'rm', '--force', name], options);
    }

    removeImage(image, options = {}) {
        return this.run(['image', 'rm', '--force', image], options);
    }
}

module.exports = { DockerClient, runProcess };
