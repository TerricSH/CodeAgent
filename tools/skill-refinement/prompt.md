# Skill Refinement Tool

Use `skill_refinement` only for explicit Skill refinement work.

- `list_suites` lists host-owned train/selection/test suites.
- `refine` runs one complete SkillOpt session. The frozen task model collects scored training
  batches; the optimizer reflects over separate success/failure minibatches, proposes bounded local
  edits, and accepts a candidate only when its mean score strictly improves on the held-out
  selection split. The disjoint test split runs once on the best accepted Skill.
- `history` and `result` inspect prior refinement artifacts.
- `status` checks Docker, the sandbox image, suites, and recent runs.

The Tool never overwrites or activates the source Skill. It writes the best validation-gated Skill
under the current session's `.code/sandboxes/.../skill-refinement-runs/` artifact directory. A
reflection model proposes and ranks edits but never supplies evaluation rewards; rewards come only
from the suite's automated harness.

Suites may select separate `templateModel` and `reflectionModel` references. Both endpoints must
return explicit reasoning/thinking events.
