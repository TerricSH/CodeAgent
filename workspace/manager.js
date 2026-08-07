const path = require('node:path');
const { WorkspaceService } = require('./service');
const { WorkspaceAccess } = require('./access');
const { formatWorkspaceError } = require('./errors');

function freeze(value) {
    return Object.freeze(value);
}

class WorkspaceManager {
    constructor(config = {}) {
        this._workspace = new WorkspaceService(config);
        this._version = 1;
    }

    get current() {
        return this._workspace;
    }

    prepare(root) {
        const requestedRoot = path.isAbsolute(String(root || ''))
            ? root
            : path.resolve(this._workspace.root, String(root || ''));
        return new WorkspaceService({ root: requestedRoot });
    }

    checkpoint() {
        return freeze({ workspace: this._workspace, version: this._version });
    }

    activate(workspace) {
        if (!(workspace instanceof WorkspaceService)) {
            throw new TypeError('WorkspaceManager can only activate a prepared WorkspaceService');
        }
        if (workspace.root === this._workspace.root) return false;
        this._workspace = workspace;
        this._version += 1;
        return true;
    }

    restore(checkpoint) {
        if (!checkpoint || !(checkpoint.workspace instanceof WorkspaceService)) {
            throw new TypeError('Invalid WorkspaceManager checkpoint');
        }
        this._workspace = checkpoint.workspace;
        this._version = checkpoint.version;
    }

    status() {
        return freeze({
            ...this._workspace.status(),
            version: this._version,
        });
    }

    createRuntimeCapabilities(options = {}) {
        const workspace = this._workspace;
        const version = this._version;
        const access = new WorkspaceAccess(workspace, { askUser: options.askUser });
        const status = () => ({ ...access.status(), version });

        return freeze({
            workspace: freeze({
                status,
                requestAccess: (request) => access.requestAccess(request),
            }),
            fileSystem: freeze({
                resolveExisting: (input, resolveOptions) => access.resolveExisting(input, resolveOptions),
                resolveForWrite: (input) => access.resolveForWrite(input),
                relative: (candidate) => access.relative(candidate),
                formatError: formatWorkspaceError,
            }),
            commandScope: freeze({
                cwd: workspace.root,
                environment: freeze({ WORKSPACE_ROOT: workspace.root }),
            }),
            memoryScope: freeze({ projectKey: workspace.projectKey }),
            sandboxScope: freeze({
                projectRoot: workspace.root,
                sandboxRoot: path.join(workspace.root, '.code', 'sandboxes'),
            }),
        });
    }
}

module.exports = WorkspaceManager;
