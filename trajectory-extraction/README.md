# Trajectory Extraction

`trajectory-extraction/` converts raw agent messages and verifier outcomes into a stable,
source-addressable trace. It is independent of Skill Refinement, model providers, storage,
Workspace, and the Tool registry.

The schema uses an agent trace with ordered input, LLM, and tool spans. Tool-call spans point back
to the assistant/tool message indexes that produced them. Outcome signals reference span IDs, so a
consumer can inspect the source instead of trusting an ungrounded summary.

The extractor performs deterministic parsing only:

- pairs tool calls and results by `tool_call_id`;
- parses structured arguments/results and redacts common secret fields;
- classifies tool status and likely observation/mutation/verification phases;
- attaches diff, evaluator, protected-path, and reward outcomes;
- detects repeated calls and compares multiple rollouts;
- labels verifier links as temporal/heuristic rather than proven causality.

`tools/trajectory-extract/` is the model-callable file adapter. It reads a saved JSON/JSONL process
file and writes cleaned output beside it. Skill Refinement does not import this module: it only
persists lossless raw Rollout JSONL which may later be passed to the Tool.

The Tool also accepts `sourceType: "audit"` for normal daily tasks:

- a known `traceId` or `sessionId` is read directly in Audit sequence order;
- a free-form `query` uses History RAG only to locate Trace IDs, then reconstructs each Trace from
  ordered Audit events;
- `includeSubagents` recursively expands child Trace references;
- reasoning and Context events can be included or filtered without changing the raw Audit source.

Cleaned Audit trajectories default to `.code/trajectories/`. They are derived artifacts and never
replace the PostgreSQL Audit Event Store or Skill Refinement raw JSON/JSONL.
