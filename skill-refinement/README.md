# Skill Refinement

Skill Refinement is CodeAgent's SkillOpt-style evaluation and refinement subsystem. It improves
reusable agent Skills; it does not train model weights, calculate gradients, manage optimizers, or
write checkpoints.

## Flow

```text
Skill seed + fixed task
  -> isolated Rollouts
  -> fixed evaluator and protected-path checks
  -> scored ranking
  -> model synthesis from rollout evidence
  -> refined-skill.md candidate
```

Every Rollout starts from the same sanitized project snapshot. `.git`, `.code`, `node_modules`,
`.env*`, and known provider credential files are excluded. The suite owns the task, evaluator, and
protected paths; Rollout agents cannot replace them.

The source Skill is never overwritten. Each run stores its evidence, result, and refined candidate
under `.code/sandboxes/<session>/skill-refinement-runs/<run-id>/`.

## Code boundaries

- `suite.js`: validates and loads host-owned suite definitions.
- `rollout-runner.js`: runs one isolated agent attempt using the candidate Skill.
- `service.js`: snapshots workspaces, executes Rollouts, evaluates, ranks, and owns artifacts.
- `refiner.js`: converts scored evidence into a refined Skill candidate.
- `tools/skill-refinement/`: exposes the single core `skill_refinement` Tool.
- `sandbox/`: shared Docker process and isolation policy primitives.

## Tool actions

- `status`: check Docker, image readiness, suites, and recent runs.
- `list_suites`: list valid suites and manifest errors.
- `refine`: execute and evaluate Rollouts, then produce a refined Skill candidate.
- `history`: list persisted refinement runs.
- `result`: load a persisted run, ranking, and candidate.

Only the main agent may start `refine`; read-only actions remain available to subagents.
