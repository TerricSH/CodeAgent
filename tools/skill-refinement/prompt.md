# Skill Refinement Tool

Use `skill_refinement` only for explicit Skill refinement work.

- `list_suites` lists host-owned refinement suites.
- `refine` evaluates the suite's current Skill through isolated Rollouts, ranks them with the
  suite's fixed evaluator, and synthesizes a refined Skill candidate.
- `history` and `result` inspect prior refinement artifacts.
- `status` checks Docker, the sandbox image, suites, and recent runs.

The Tool never overwrites the source Skill. A refined candidate is written under the current
session's `.code/sandboxes/.../skill-refinement-runs/` artifact directory for review.
