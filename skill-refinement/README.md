# Skill Refinement

`skill-refinement` is CodeAgent's isolated SkillOpt implementation. It optimizes one compact
Markdown Skill while keeping the task-execution model, harness, main Agent, and model weights
fixed.

## Optimization loop

One explicit `refine` call owns the complete session:

```text
seed Skill -> mean score on Dselection
  -> fresh Dtrain rollout batch with current Skill
  -> separate failure/success reflection minibatches
  -> hierarchical failure merge + success merge + failure-prioritized final merge
  -> optimizer ranking clipped to textual edit budget L_t
  -> local append/insert_after/replace/delete patch
  -> fixed Dselection mean-score gate (strict improvement; ties rejected)
  -> epoch-local rejected-edit feedback and optional slow/meta update
  -> one final evaluation of best Skill on disjoint Dtest
```

The source Skill and project repository are never modified. A temporary Git repository under the
run artifact records accepted versions; the final `.git` directory is removed after history and
diffs are exported. The result remains as `refined-skill.md` and `skill-worktree/SKILL.md`.

## Evidence and scoring

The suite adapter supplies disjoint train, selection, and test tasks. The automated evaluator
returns a scalar reward in `[0,1]`; binary test commands are supported directly, and structured
JSON output supports partial rewards. Selection and test use arithmetic means. The optimizer model
can diagnose trajectories and rank edits but cannot create or alter rewards. The private suite
directory is removed from every rollout snapshot, so the task model cannot inspect held-out
selection/test manifests while running training tasks.

Each optimization step collects new training evidence under the current accepted Skill. Candidate
selection trajectories are never reflected. A rejected step contributes only its failure patterns,
attempted edits, and score delta to an epoch-local negative-feedback buffer.

## Reflection and bounded edits

Training trajectories are partitioned semantically into failure and success minibatches. Analyst
calls run with bounded concurrency. Failure and success patches are consolidated independently,
then merged with priority on corrections. The ranking call may select only edits already present in
the merged pool, and deterministic enforcement applies no more than `L_t` edits even if a model
returns too many.

Fast patches cannot touch `SLOW_UPDATE` or `APPENDIX` protected regions. Starting with epoch two,
slow update compares the same sampled training items under adjacent epoch-end Skills and proposes
longitudinal guidance for the protected region; that candidate still requires strict selection
improvement. Optimizer meta guidance summarizes accepted, rejected, and persistent patterns and is
prepended only to future optimizer prompts.

## Isolation and artifacts

The implementation reuses the public `SandboxPool`: one sanitized snapshot per optimization run,
one independent copy-on-write container per rollout, bounded active commands, no network, resource
limits, retry classification, and deterministic cleanup. Batch size is an evidence boundary, not a
requirement that every container run simultaneously.

Artifacts include raw semantic events, transport attempts, exclusions, cleaned per-batch
trajectories, scored rollout records, per-step patch/application reports, optimizer state, Git
history/diffs, and workspace-retention records. Failed transport or sandbox attempts remain
auditable but are excluded from reflection.

## Module boundaries

- `suite.js`: schema-v2 dataset, optimizer, evaluator, reward, and protected-path validation.
- `orchestrator.js`: train/selection/test loop, strict gate, cache, rejected buffer, and epoch flow.
- `refiner.js`: success/failure minibatches, parallel analysis, hierarchical merge, and ranking.
- `optimizer-memory.js`: slow-update comparison and optimizer-only meta guidance.
- `rollout-coordinator.js`: isolated rollout retries, evaluation, and normalized reward outcome.
- `skill-patch.js`: patch validation, Top-L enforcement, protected regions, and deterministic apply.
- `trajectory-journal.js`: transport, semantic, exclusion, blob, and cleaned trajectory layers.
- `git-skill-store.js`: one temporary repository for accepted Skill versions.
- `artifact-repository.js`: run, batch, step, optimizer-state, result, and candidate artifacts.

The core `skill_refinement` Tool still exposes `status`, `list_suites`, `refine`, `history`, and
`result`, and only the main Agent may start a refinement run. Suite manifests accept schema v2
only, completed run artifacts accept result schema v4 only, and legacy fields or result aliases are
rejected rather than migrated.
