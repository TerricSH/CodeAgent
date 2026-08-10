const fs = require('node:fs');

function fail(summary, evidence = {}) {
    return { status: 'FAIL', summary, evidence };
}

module.exports = {
    type: 'file',
    verify(check, runtime = {}) {
        const fileSystem = runtime.fileSystem;
        if (!fileSystem || typeof fileSystem.resolveExisting !== 'function') {
            return { status: 'INCONCLUSIVE', summary: 'File capability is unavailable', evidence: {} };
        }
        let resolved;
        try {
            resolved = fileSystem.resolveExisting(check.path);
        } catch (error) {
            if (check.exists === false && /does not exist|not found/i.test(error.message)) {
                return { status: 'PASS', summary: 'Path does not exist as required', evidence: { path: check.path } };
            }
            if (error.code === 'WORKSPACE_APPROVAL_REQUIRED') {
                return { status: 'INCONCLUSIVE', summary: error.message, evidence: { code: error.code } };
            }
            return fail(`Required path is unavailable: ${check.path}`, { error: error.message });
        }
        if (check.exists === false) return fail(`Path exists but must not: ${check.path}`, { path: check.path });
        const stat = fs.statSync(resolved);
        if (check.kind === 'file' && !stat.isFile()) return fail('Path is not a file', { path: check.path });
        if (check.kind === 'directory' && !stat.isDirectory()) return fail('Path is not a directory', { path: check.path });
        let content = null;
        if (check.nonEmpty || check.contains !== undefined || check.matches !== undefined) {
            if (!stat.isFile()) return fail('Content assertions require a file', { path: check.path });
            content = fs.readFileSync(resolved, 'utf8');
        }
        if (check.nonEmpty && content.length === 0) return fail('File is empty', { path: check.path });
        if (check.contains !== undefined && !content.includes(check.contains)) {
            return fail('File does not contain the required text', { path: check.path, contains: check.contains });
        }
        if (check.matches !== undefined && !new RegExp(check.matches).test(content)) {
            return fail('File does not match the required pattern', { path: check.path, matches: check.matches });
        }
        return { status: 'PASS', summary: 'File assertions passed', evidence: { path: check.path, size: stat.size } };
    },
};
