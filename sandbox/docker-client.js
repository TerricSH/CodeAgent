const { spawn } = require('node:child_process');

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
                stdio: ['ignore', 'pipe', 'pipe'],
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

    removeContainer(name, options = {}) {
        return this.run(['container', 'rm', '--force', name], options);
    }
}

module.exports = { DockerClient, runProcess };
