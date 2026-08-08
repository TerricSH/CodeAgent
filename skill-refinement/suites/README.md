# Skill Refinement suites

Create one directory per suite:

```text
skill-refinement/suites/
└── node-process-safety/
    ├── suite.json
    └── seed-skill.md
```

Suite directories contain mutable creation/refinement inputs and are ignored by Git. Only this
README and `suite.template.json` are versioned. Final verified Skills belong under `skills/<name>/`;
Rollout workspaces, evidence, and generated candidates remain under the ignored `.code/` runtime
tree.

Copy `suite.template.json` into the new directory as `suite.json`, then replace its identifiers,
model references, task, Skill path, and evaluator.

Example `suite.json`:

```json
{
  "schemaVersion": 1,
  "id": "node-process-safety",
  "templateModel": "vendor@interface/template-model",
  "reflectionModel": "vendor@interface/reflection-model",
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
- `templateModel` selects the model that executes candidate Rollouts.
- `reflectionModel` selects the model that reads scored evidence and writes `refined-skill.md`.
- Model references use `vendor[@interface][/model]`. API keys remain in provider configuration;
  never put credentials in a suite manifest.
- Either model field may be omitted to use the current session model for that role.
- `rollouts` is clamped to 2-8.
- The evaluator and protected paths are fixed by the suite.
- A protected-path change scores `-1`; other candidates score `1` on pass and `0` on failure.
- Ties prefer smaller changes and then faster evaluation.
