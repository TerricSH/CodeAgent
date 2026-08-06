const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realPath(value) {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function workspaceId(root) {
    const identity = process.platform === 'win32' ? root.toLowerCase() : root;
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

class WorkspaceApprovalRequiredError extends Error {
    constructor({ access, requestedPath, target, reason }) {
        super(`Workspace access requires user approval: ${access} ${target}`);
        this.name = 'WorkspaceApprovalRequiredError';
        this.code = 'WORKSPACE_APPROVAL_REQUIRED';
        this.access = access;
        this.requestedPath = requestedPath;
        this.target = target;
        this.reason = reason;
    }
}

class WorkspaceService {
    constructor(config = {}) {
        const configuredRoot = config.root || process.env.WORKSPACE_ROOT || process.cwd();
        const resolvedRoot = path.resolve(String(configuredRoot));
        let stat;
        try { stat = fs.statSync(resolvedRoot); } catch { stat = null; }
        if (!stat || !stat.isDirectory()) {
            throw new Error(`Workspace root must be an existing directory: ${resolvedRoot}`);
        }

        this.root = realPath(resolvedRoot);
        this.id = workspaceId(this.root);
        this.projectKey = `workspace:${this.id}`;
    }

    _candidatePath(input = '.') {
        const value = String(input || '.');
        if (value.includes('\0')) throw new Error('Workspace path contains a null byte');
        return path.isAbsolute(value)
            ? path.resolve(value)
            : path.resolve(this.root, value);
    }

    _authorize(candidate, canonical, requestedPath, access, authorize) {
        if (isInside(this.root, canonical)) return canonical;
        if (typeof authorize === 'function' && authorize(canonical, access)) return canonical;
        throw new WorkspaceApprovalRequiredError({
            access,
            requestedPath: String(requestedPath || '.'),
            target: canonical,
            reason: isInside(this.root, candidate) ? 'link_escape' : 'path_escape',
        });
    }

    _realPath(candidate, requestedPath, access, authorize) {
        const canonical = realPath(candidate);
        return this._authorize(candidate, canonical, requestedPath, access, authorize);
    }

    resolveExisting(input = '.', options = {}) {
        const access = options.access || (options.type === 'directory' ? 'list' : 'read');
        const candidate = this._candidatePath(input);
        if (!fs.existsSync(candidate)) throw new Error(`Workspace path does not exist: ${input}`);
        const canonical = this._realPath(candidate, input, access, options.authorize);
        const stat = fs.statSync(canonical);
        if (options.type === 'file' && !stat.isFile()) {
            throw new Error(`Workspace path is not a file: ${input}`);
        }
        if (options.type === 'directory' && !stat.isDirectory()) {
            throw new Error(`Workspace path is not a directory: ${input}`);
        }
        return canonical;
    }

    resolveForWrite(input, options = {}) {
        if (input == null || String(input).trim() === '') {
            throw new Error('Workspace write path is required');
        }
        const candidate = this._candidatePath(input);
        if (fs.existsSync(candidate)) {
            return this._realPath(candidate, input, 'write', options.authorize);
        }

        let ancestor = path.dirname(candidate);
        while (!fs.existsSync(ancestor)) {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) throw new Error(`Cannot resolve workspace write path: ${input}`);
            ancestor = parent;
        }
        const canonicalAncestor = realPath(ancestor);
        const suffix = path.relative(ancestor, candidate);
        const canonical = path.resolve(canonicalAncestor, suffix);
        return this._authorize(candidate, canonical, input, 'write', options.authorize);
    }

    relative(candidate) {
        const resolved = path.resolve(candidate);
        if (!isInside(this.root, resolved)) throw new Error('Path is outside workspace root');
        const relative = path.relative(this.root, resolved);
        return relative ? relative.split(path.sep).join('/') : '.';
    }

    status() {
        return {
            configured: true,
            id: this.id,
            root: this.root,
            projectKey: this.projectKey,
        };
    }
}

module.exports = {
    WorkspaceService,
    WorkspaceApprovalRequiredError,
    isInside,
};
