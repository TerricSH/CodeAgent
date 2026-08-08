# Skill Refinement

`skill-refinement` is the execution layer for evaluating and improving an existing Skill seed.
The project Skill at `skills/skill-creator` may create a cold-start seed and suite, but it delegates
all isolated Rollouts, verification, ranking, model resolution, and artifact handling here.

Skill Refinement is CodeAgent's SkillOpt-style evaluation and refinement subsystem. It improves
reusable agent Skills; it does not train model weights, calculate gradients, manage optimizers, or
write checkpoints.

## Flow

```text
Skill seed + fixed task
  -> templateModel: isolated Rollouts
  -> fixed evaluator and protected-path checks
  -> persist lossless raw-rollout-trajectories.jsonl
  -> scored ranking
  -> reflectionModel: synthesis from scored evidence
  -> refined-skill.md candidate
```

Every Rollout starts from the same sanitized project snapshot. `.git`, `.code`, `node_modules`,
`.env*`, and known provider credential files are excluded. The suite owns the task, evaluator, and
protected paths; Rollout agents cannot replace them.

The source Skill is never overwritten. Each run stores its complete raw messages, tool calls, tool
results, evaluator result, diff, and reward in `raw-rollout-trajectories.jsonl` before reflection
starts. This preserves the process even if candidate synthesis later fails. The result and refined
candidate live in the same `.code/sandboxes/<session>/skill-refinement-runs/<run-id>/` directory.

Trajectory cleaning is deliberately outside this subsystem. `trajectory_extract` may later read
the raw JSONL path and create a separate `*.cleaned.json`; Skill Refinement neither imports nor
invokes the trajectory extractor. The persisted file format is their only integration boundary.

## Code boundaries

- `suite.js`: validates and loads host-owned suite definitions.
- `rollout-runner.js`: runs one isolated agent attempt using the candidate Skill.
- `rollout-coordinator.js`: prepares, evaluates, scores, and records one Rollout.
- `orchestrator.js`: coordinates one refinement run without owning infrastructure details.
- `evaluator.js`: executes fixed commands in isolated Docker workspaces.
- `workspace.js`: owns sanitized snapshots, diffs, and protected-path checks.
- `artifact-repository.js`: persists raw trajectories, run records, history, and candidates.
- `models.js`: resolves the template and reflection model roles.
- `prompts/`: owns the Rollout, reflection-system, and reflection-user prompt templates.
- `evidence.js`: defines the stable reflection evidence shape.
- `refiner.js`: converts scored evidence into a refined Skill candidate.
- `service.js`: lightweight composition façade for the modules above.
- `tools/skill-refinement/`: exposes the single core `skill_refinement` Tool.
- `sandbox/`: shared Docker process and isolation policy primitives.

## Tool actions

- `status`: check Docker, image readiness, suites, and recent runs.
- `list_suites`: list valid suites and manifest errors.
- `refine`: execute and evaluate Rollouts, then produce a refined Skill candidate.
- `history`: list persisted refinement runs.
- `result`: load a persisted run, ranking, and candidate.

Only the main agent may start `refine`; read-only actions remain available to subagents.

## Model roles

Each `suite.json` may set two independent model references:

```json
{
  "templateModel": "vendor@interface/template-model",
  "reflectionModel": "vendor@interface/reflection-model"
}
```

`templateModel` performs the task Rollouts. `reflectionModel` receives normalized scored evidence
and produces the refined Skill. References are resolved through the runtime `modelResolver`
capability and do not switch the main conversation model. An omitted role falls back to the current
session model. Resolved model information is recorded in `result.json` and the JSONL evidence.
