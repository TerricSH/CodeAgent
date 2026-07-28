# Docker sandbox

Use `docker-sandbox__sandbox_exec` for untrusted code, builds, and automated evaluation.
The workspace is isolated from the project and persists for the current session. Commands marked
with `purpose: "evaluation"` are treated as reward-bearing tests; use that purpose only for
meaningful verification, not ordinary exploration. Network access is disabled by default.
Never assume a successful sandbox command modified host project files.
