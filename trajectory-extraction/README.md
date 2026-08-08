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
