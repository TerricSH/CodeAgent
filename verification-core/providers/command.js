const { spawn } = require('node:child_process');

const MAX_OUTPUT = 256 * 1024;

function terminateTree(child) {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
        try {
            const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
                windowsHide: true,
                stdio: 'ignore',
            });
            killer.on('error', () => child.kill());
            killer.unref();
        } catch {
            child.kill();
        }
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

function append(buffer, chunk, state) {
    const value = String(chunk || '');
    if (buffer.value.length >= MAX_OUTPUT) {
        state.truncated = true;
        return;
    }
    const remaining = MAX_OUTPUT - buffer.value.length;
    buffer.value += value.slice(0, remaining);
    if (value.length > remaining) state.truncated = true;
}

module.exports = {
    type: 'command',
    verify(check, runtime = {}) {
        const scope = runtime.commandScope;
        if (!scope || !scope.cwd) {
            return Promise.resolve({
                status: 'INCONCLUSIVE',
                summary: 'Command capability is unavailable',
                evidence: {},
            });
        }
        return new Promise((resolve) => {
            const stdout = { value: '' };
            const stderr = { value: '' };
            const state = { truncated: false, timedOut: false };
            const started = Date.now();
            let settled = false;
            let child;
            try {
                child = spawn(check.command, {
                    cwd: scope.cwd,
                    env: { ...process.env, ...(scope.environment || {}) },
                    shell: true,
                    windowsHide: true,
                    detached: process.platform !== 'win32',
                });
            } catch (error) {
                resolve({ status: 'INCONCLUSIVE', summary: error.message, evidence: { error: error.message } });
                return;
            }
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                state.timedOut = true;
                terminateTree(child);
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.stdin?.destroy();
                child.unref();
                resolve({
                    status: 'FAIL',
                    summary: `Command timed out after ${check.timeoutMs}ms`,
                    evidence: {
                        command: check.command,
                        exitCode: null,
                        signal: null,
                        timedOut: true,
                        durationMs: Date.now() - started,
                        stdout: stdout.value,
                        stderr: stderr.value,
                        truncated: state.truncated,
                    },
                });
            }, check.timeoutMs);
            child.stdout?.on('data', chunk => append(stdout, chunk, state));
            child.stderr?.on('data', chunk => append(stderr, chunk, state));
            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    status: 'INCONCLUSIVE',
                    summary: `Command could not start: ${error.message}`,
                    evidence: { error: error.message, durationMs: Date.now() - started },
                });
            });
            child.on('close', (exitCode, signal) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const passed = exitCode === 0 && !state.timedOut;
                resolve({
                    status: passed ? 'PASS' : 'FAIL',
                    summary: state.timedOut
                        ? `Command timed out after ${check.timeoutMs}ms`
                        : `Command exited with code ${exitCode}`,
                    evidence: {
                        command: check.command,
                        exitCode,
                        signal: signal || null,
                        timedOut: state.timedOut,
                        durationMs: Date.now() - started,
                        stdout: stdout.value,
                        stderr: stderr.value,
                        truncated: state.truncated,
                    },
                });
            });
        });
    },
};

module.exports.terminateTree = terminateTree;
