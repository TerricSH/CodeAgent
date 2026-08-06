const path = require('node:path');
const { WorkspaceApprovalRequiredError } = require('./service');

const ACCESS = new Set(['read', 'write', 'list']);

function approvalKey(target, access) {
    const normalized = path.resolve(target);
    const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return `${access}\n${identity}`;
}

class WorkspaceAccess {
    constructor(workspace, options = {}) {
        this.workspace = workspace;
        this.askUser = typeof options.askUser === 'function' ? options.askUser : null;
        this.oneTimeGrants = new Map();
    }

    get root() { return this.workspace.root; }
    get id() { return this.workspace.id; }
    get projectKey() { return this.workspace.projectKey; }

    _consume(target, access) {
        const key = approvalKey(target, access);
        const remaining = this.oneTimeGrants.get(key) || 0;
        if (remaining < 1) return false;
        if (remaining === 1) this.oneTimeGrants.delete(key);
        else this.oneTimeGrants.set(key, remaining - 1);
        return true;
    }

    _grant(target, access) {
        const key = approvalKey(target, access);
        this.oneTimeGrants.set(key, (this.oneTimeGrants.get(key) || 0) + 1);
    }

    resolveExisting(input = '.', options = {}) {
        return this.workspace.resolveExisting(input, {
            ...options,
            authorize: (target, access) => this._consume(target, access),
        });
    }

    resolveForWrite(input) {
        return this.workspace.resolveForWrite(input, {
            authorize: (target, access) => this._consume(target, access),
        });
    }

    relative(candidate) {
        const resolved = path.resolve(candidate);
        if (resolved === this.root || resolved.startsWith(`${this.root}${path.sep}`)) {
            return this.workspace.relative(resolved);
        }
        return resolved;
    }

    status() {
        return {
            ...this.workspace.status(),
            outsideAccess: 'explicit-user-approval-once',
            activeOneTimeGrants: [...this.oneTimeGrants.values()].reduce(
                (sum, count) => sum + count,
                0
            ),
        };
    }

    _inspect(pathValue, access) {
        try {
            if (access === 'write') return this.workspace.resolveForWrite(pathValue);
            return this.workspace.resolveExisting(pathValue, {
                type: access === 'list' ? 'directory' : 'file',
                access,
            });
        } catch (error) {
            if (error instanceof WorkspaceApprovalRequiredError) return error;
            throw error;
        }
    }

    async requestAccess(options = {}) {
        const access = String(options.access || 'read');
        if (!ACCESS.has(access)) throw new Error(`Unsupported workspace access type: ${access}`);
        const requestedPath = String(options.path || '').trim();
        if (!requestedPath) throw new Error('Workspace approval path is required');
        const reason = String(options.reason || '').trim();
        if (!reason) throw new Error('Workspace approval reason is required');
        const inspected = this._inspect(requestedPath, access);
        if (!(inspected instanceof WorkspaceApprovalRequiredError)) {
            return {
                approved: true,
                approvalRequired: false,
                access,
                path: inspected,
                message: 'The requested path is already inside the workspace.',
            };
        }
        if (!this.askUser) {
            return {
                approved: false,
                approvalRequired: true,
                interactive: false,
                access,
                path: inspected.target,
                reason: inspected.reason,
                message: 'Interactive user approval is unavailable.',
            };
        }

        const purpose = `\n原因：${reason.slice(0, 500)}`;
        const answer = await this.askUser({
            intro: 'Agent 请求访问当前 Workspace 之外的路径。',
            text: `是否允许本次 ${access} 操作？\n路径：${inspected.target}${purpose}`,
            options: ['允许本次访问', '拒绝'],
            allowFreeform: false,
        });
        const approved = answer === '允许本次访问';
        if (approved) this._grant(inspected.target, access);
        return {
            approved,
            approvalRequired: true,
            interactive: true,
            access,
            path: inspected.target,
            reason: inspected.reason,
            scope: approved ? 'once' : null,
        };
    }
}

module.exports = { WorkspaceAccess, approvalKey };
