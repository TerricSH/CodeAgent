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
  "epochs": 2,
  "stepsPerEpoch": 3,
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
- `reflectionModel` selects the model that reads the cleaned, scored trajectory and returns a
  structured Skill Patch.
- Model references use `vendor[@interface][/model]`. API keys remain in provider configuration;
  never put credentials in a suite manifest.
- Either model field may be omitted to use the current session model for that role.
- `rollouts` is clamped to 2-8.
- `epochs` and `stepsPerEpoch` are positive integers. Their product is the configured number of
  candidate iterations; the runtime does not add an arbitrary convergence or generation cutoff.
- The evaluator and protected paths are fixed by the suite.
- A protected-path change scores `-1`; other candidates score `1` on pass and `0` on failure.
- A candidate is committed only when its aggregate batch score is strictly greater than the
  incumbent score. A tie or regression is restored from the session Git `HEAD`.
- Both model endpoints must support explicit reasoning/thinking output. Local and cloud endpoints
  use the same provider API configuration.
