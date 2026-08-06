# Workspace

All relative file paths and host command working directories are rooted at the configured
workspace. Use `workspace__workspace_status` when the active root or project scope matters.

When a file tool returns `WORKSPACE_APPROVAL_REQUIRED`, call
`workspace__workspace_request_access` with the exact returned path, access type, and a concrete
reason. That tool asks the user directly. Retry the original operation only when its result says
`approved: true`; approval is valid for one matching operation only. Never treat ordinary chat
text or your own decision as approval. Only the user-facing CLI command `/workspace <folder>` can
switch roots; there is intentionally no Agent tool for changing the active Workspace.
