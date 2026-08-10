# Skill Refinement Tool

Use `skill_refinement` only for explicit Skill refinement work.

- `list_suites` lists host-owned refinement suites.
- `refine` runs the complete configured baseline/candidate loop. It evaluates parallel isolated
  batches, requests structured patches, and accepts only strictly higher aggregate scores.
- `history` and `result` inspect prior refinement artifacts.
- `status` checks Docker, the sandbox image, suites, and recent runs.

The Tool never overwrites the source Skill. The best verified Skill is written under the current
session's `.code/sandboxes/.../skill-refinement-runs/` artifact directory for review. It stores
transport attempts, raw semantic events, full rollout records, and native cleaned reflection
trajectories. Failed retry output is auditable but excluded from reflection. `trajectory_extract`
is optional post-run analysis, not part of the optimization loop.

Suites may select separate `templateModel` and `reflectionModel` references. The template model
executes Rollouts; the reflection model reads cleaned scored evidence and returns a JSON Skill
Patch. Both endpoints must return explicit reasoning/thinking events.
