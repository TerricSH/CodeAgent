# trajectory_extract

Use `trajectory_extract` to clean a previously saved JSON/JSONL process file into ordered,
traceable input/LLM/tool spans. The raw source is never overwritten; cleaned output is saved to a
separate JSON file. Multiple records also receive an evidence-linked comparison.

The extractor is deterministic. Associations and verifier links are explicitly non-causal; use the
returned message indexes and span IDs to inspect supporting evidence before drawing conclusions.
