# Development-training suites

The Docker sandbox trains only from explicit, host-owned suites. Ordinary conversations and
ad-hoc `sandbox_exec` commands are not harvested as training tasks.

Create one directory per suite:

```text
training/suites/
└── node-process-safety/
    ├── suite.json
    └── seed-skill.md
```

Example `suite.json`:

```json
{
  "schemaVersion": 1,
  "id": "node-process-safety",
  "task": "Fix the child-process lifecycle bugs without weakening the tests.",
  "baseline": ".",
  "skillPath": "seed-skill.md",
  "rollouts": 4,
  "protectedPaths": [
    "test",
    "package.json",
    "package-lock.json"
  ],
  "evaluation": {
    "command": "npm test",
    "timeoutMs": 120000
  }
}
```

Rules:

- The directory name and `id` must match and use letters, numbers, `.`, `_`, or `-`.
- `baseline` is relative to the configured project root and cannot escape it.
- `skillPath` is optional and must remain inside the suite directory.
- `rollouts` is clamped to 2-8.
- The rollout agent receives the task and skill but cannot replace the evaluator or protected paths.
- Each rollout starts from an independent copy of the same baseline. `.git`, `.code`,
  `node_modules`, `.env*`, and known provider credential configs are excluded from snapshots.
- Symbolic links and junctions are rejected in snapshots and rollout workspaces.
- A protected-path change receives score `-1` and is never evaluated.
- Other candidates score `1` for a passing evaluator and `0` for failure. Ties prefer the smaller
  change, then the faster evaluation.

Tools:

- `docker-sandbox__sandbox_training_suites`: list valid suites and manifest errors.
- `docker-sandbox__sandbox_training_start`: execute all isolated rollouts and select the best one.
- `docker-sandbox__sandbox_training_history`: list recent runs.
- `docker-sandbox__sandbox_training_result`: read a run's ranking and artifact locations.

Artifacts are written beneath:

```text
.code/sandboxes/<session>/training-runs/<run-id>/
```

`skillopt-rollouts.jsonl` contains the task, current skill, complete rollout messages, external
evaluation, protected-path violations, workspace diff, and reward. It is adapter input for the
separate SkillOpt optimization stage; the Docker sandbox does not claim to update model weights or
promote a skill by itself.
