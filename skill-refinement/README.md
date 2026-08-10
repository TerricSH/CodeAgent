# Skill Refinement

`skill-refinement` is CodeAgent's SkillOpt-style execution layer. It improves a Markdown Skill
through fixed, isolated task batches; it does not update model weights, calculate gradients, or
manage training checkpoints.

## Optimization loop

One `refine` call owns the complete configured session:

```text
sanitized project snapshot + seed SKILL.md
  -> baseline batch (parallel rollout agents)
  -> cleaned, scored trajectory
  -> reflection API returns structured Skill Patch
  -> deterministic patch application
  -> candidate batch on the same fixed task/evaluator
  -> accept only when aggregate candidate score > incumbent score
  -> repeat for epochs × stepsPerEpoch
  -> export the best verified Skill and version history
```

Task and test failures are valid evidence. Model transport failures, OOMs, sandbox timeouts, and
Docker infrastructure failures are retried once at their appropriate boundary. An unresolved
infrastructure sample receives no score. A recovered attempt remains in raw audit data but is
excluded from the reflection trajectory, so retry noise cannot teach the Skill.

There is no pass-rate heuristic, implicit generation cutoff, or tie-break acceptance. A tie or
regression restores the current Git `HEAD`; only a strictly higher aggregate score is committed.

## Public sandbox

Both the interactive Docker plugin and Skill Refinement use `sandbox/SandboxPool`. Skill
Refinement builds one sanitized snapshot image for the complete optimization session. Each rollout
gets an independent persistent container with its own Docker copy-on-write writable layer.

Containers remain stopped while a model is generating or reflecting. `start -> exec -> stop` occurs
only for a tool or evaluator command, so many waiting rollouts do not consume active container CPU
or their full hard memory limit. Different leases execute concurrently under the pool's active
limit; commands within one lease remain serialized.

Default resource policy:

- 8 active commands maximum;
- 512 MiB hard memory and 128 MiB reservation per active container;
- active limit additionally bounded by 75% of Docker Engine memory divided by the reservation;
- 1 GiB writable layer per container;
- reject new snapshot, lease, or command admission at 85% Docker-disk utilization;
- halve active concurrency after an OOM;
- no network, all Linux capabilities dropped, `no-new-privileges`, PID/CPU/tmpfs limits, and a
  non-root user.

The shared snapshot supplies disk deduplication; containers never share a writable workspace.
After a batch is scored, host-side exports are pruned as well: non-best workspaces are removed
immediately, rejected candidates discard their remaining workspace, and an accepted candidate
replaces the prior incumbent. Only the final best verified workspace is retained. Every removal is
listed in `workspace-retention.jsonl`; trajectories, evaluations, hashes, and diffs remain intact.

## Models and reasoning

Suites may select independent API-backed roles:

```json
{
  "templateModel": "vendor@interface/template-model",
  "reflectionModel": "vendor@interface/reflection-model"
}
```

The template model executes rollouts; the reflection model produces patches. Both are resolved by
the existing model-provider runtime and can point to a cloud endpoint or a local HTTP service such
as an OpenAI-compatible local server. They do not switch the main conversation model.

Reasoning/thinking is required for both roles. The provider interface enables the protocol's
reasoning option and must return explicit `thinking` events. A successful logical call is buffered
and committed atomically only after its stream completes. Each logical call has a
`logicalCallId`; HTTP attempts have `attemptNo`. Partial output from failed HTTP attempts is stored
only in `transport-attempts.jsonl`. A model stream is aborted after 120 seconds by default, then
follows the same transport-retry and exclusion rules.

## Trajectories

Each run persists three native layers:

- `transport-attempts.jsonl`: every HTTP attempt, including failed partial streams;
- `raw-semantic-events.jsonl`: only complete successful model calls plus tool/evaluation events and
  explicit infrastructure markers;
- `cleaned-trajectories.jsonl`: deterministic reflection input with reasoning/content deltas merged,
  tool calls paired with results, retry attempts excluded, and `sourceEventIds` retained.

Per-batch cleaned views live under `trajectory-batches/`. Oversized span content is stored
losslessly in content-addressed files under `trajectory-blobs/`; reflection materializes it and
partitions oversized trajectories into lossless fragments before aggregating chunk patches. The
raw rollout/evaluator records remain in `raw-rollout-trajectories.jsonl`.

`trajectory_extract` remains available for independent post-run analysis, but it is not required
to create the reflection input.

## Structured Skill edits and Git

The reflection model returns JSON with an `edits` array. The only operations are `append`,
`insert_after`, `replace`, and `delete`. `skill-patch.js` validates and applies them sequentially;
Git is not used as a patch parser.

One ordinary temporary Git repository is initialized for the complete optimization session. It
contains only `SKILL.md`, begins with a baseline commit, and receives one commit per accepted
candidate. Rejected candidates are restored from `HEAD`. The source Skill and project repository
are never modified. At completion, history and diffs are exported, `.git` is deleted, and the
verified Skill remains as `refined-skill.md` plus `skill-worktree/SKILL.md`. Generated commit
messages use the local `SkillOpt` identity and contain no assistant attribution or co-author trailers.

## Module boundaries

- `suite.js`: validates fixed tasks, model roles, batch size, epochs, steps, evaluator, and protected
  paths.
- `orchestrator.js`: owns the baseline/candidate loop and strict score gate.
- `rollout-coordinator.js`: retries and records one isolated rollout.
- `rollout-runner.js`: runs one agent against a persistent sandbox lease.
- `evaluator.js`: adapts the public `SandboxPool`.
- `trajectory-journal.js`: owns transport, raw semantic, exclusion, blob, and cleaned trajectory
  artifacts.
- `refiner.js`: losslessly chunks evidence and requests structured patches.
- `skill-patch.js`: deterministically validates and applies patch operations.
- `git-skill-store.js`: owns the one temporary session repository.
- `artifact-repository.js`: persists batches, steps, results, and exported candidates.
- `models.js`: resolves the execution and reflection API roles.

The core `skill_refinement` Tool exposes `status`, `list_suites`, `refine`, `history`, and `result`.
Only the main agent may start `refine`; read-only actions remain available to subagents.
