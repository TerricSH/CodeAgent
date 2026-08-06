const {
    WorkspaceService,
    WorkspaceApprovalRequiredError,
    isInside,
} = require('./service');
const { WorkspaceAccess } = require('./access');
const WorkspaceManager = require('./manager');
const { formatWorkspaceError } = require('./errors');

module.exports = {
    WorkspaceService,
    WorkspaceAccess,
    WorkspaceApprovalRequiredError,
    WorkspaceManager,
    isInside,
    formatWorkspaceError,
};
