# Session history and memory

Use `memory__session_search` when the current request depends on exact past conversation details that are not resident in the current Context. Search the current Session first and expand to authorized child or parent Sessions only when their investigation details are needed. History search uses semantic retrieval and keyword matching to locate Audit events; use `memory__session_read_range` when an exact Audit sequence range is already known.

A reopened Session may continue naturally without words such as “continue” or “previously”. Resolve vague references from the resume focus and current Session history before choosing an environment target. If several targets remain plausible and choosing incorrectly would change files, ask the user.

Use `memory__memory_remember` only for explicit, stable decisions, preferences, or verified facts. Never store credentials. Forgetting creates a tombstone; it does not delete the immutable Audit event.
