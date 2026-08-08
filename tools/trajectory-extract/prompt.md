# trajectory_extract

Use `trajectory_extract` for either normal runtime Audit traces or saved Skill Refinement files.

- For an `audit:<session>:trace:<trace>:...` source reference, call with `sourceType: "audit"` and
  that `traceId`. A known Trace is read directly in sequence order; it is never reconstructed from
  search snippets.
- Use `sessionId` to extract all traces in an authorized Session.
- Use `query` only when the Trace is unknown. History RAG locates candidate Trace IDs first, then
  the Tool reads each complete Trace from Audit.
- `includeSubagents`, `includeReasoning`, and `includeContextEvents` control the cleaned view without
  modifying the raw Audit source.
- For a saved JSON/JSONL process, use `sourceType: "file"` with `sourcePath`.

The raw source is never overwritten; cleaned output is saved separately. Audit output defaults to
`.code/trajectories/`. Multiple records may receive an evidence-linked comparison.

The extractor is deterministic. Associations and verifier links are explicitly non-causal; use the
returned message indexes and span IDs to inspect supporting evidence before drawing conclusions.
