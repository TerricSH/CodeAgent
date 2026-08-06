const { WorkspaceApprovalRequiredError } = require('./service');

function formatWorkspaceError(error, fallbackLabel = 'Workspace operation failed') {
    if (error instanceof WorkspaceApprovalRequiredError) {
        return JSON.stringify({
            ok: false,
            code: error.code,
            approvalRequired: true,
            access: error.access,
            requestedPath: error.requestedPath,
            path: error.target,
            reason: error.reason,
            nextTool: 'workspace__workspace_request_access',
        }, null, 2);
    }
    return `${fallbackLabel}: ${error instanceof Error ? error.message : String(error)}`;
}

module.exports = { formatWorkspaceError };
