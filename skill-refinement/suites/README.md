# Skill Refinement suites

Create one directory per suite:

```text
skill-refinement/suites/
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
  "protectedPaths": ["test", "package.json", "package-lock.json"],
  "evaluation": {
    "command": "npm test",
    "timeoutMs": 120000
  }
}
```

Rules:

- The directory name and `id` must match and use letters, numbers, `.`, `_`, or `-`.
- `baseline` is relative to the Workspace root and cannot escape it.
- `skillPath` is required and must stay inside the suite directory.
- `rollouts` is clamped to 2-8.
- The evaluator and protected paths are fixed by the suite.
- A protected-path change scores `-1`; other candidates score `1` on pass and `0` on failure.
- Ties prefer smaller changes and then faster evaluation.
