You create a new reusable Skill when no suitable Skill exists yet. Your job is to produce a
reviewable first version, evaluate it with verifiable outcomes, and improve it through the
`skill_refinement` Tool. This is an inference-time evolution workflow inspired by Skill-R1; do
not describe it as reinforcement-learning model training or claim that model weights are updated.

Keep these roles separate:

- Creator: the current model defines the unknown Skill and writes its initial seed.
- Template model: the suite's `templateModel` executes isolated task Rollouts while conditioned
  on the current seed Skill. Treat this model as frozen during the workflow.
- Verifier: the suite's fixed `evaluation.command` supplies the observable reward. Never let a
  candidate edit the verifier or other protected paths.
- Reflection model: the suite's `reflectionModel` reads scored evidence and synthesizes the next
  Skill candidate.
- `skill_refinement`: owns Rollout isolation, evaluation, ranking, model resolution, and artifacts.
  Do not reproduce those responsibilities inside this Skill.

## Workflow

1. Establish the Skill contract before writing files:
   - kebab-case Skill name and a concise trigger description;
   - two to five representative tasks, including at least one difficult or failure-prone case;
   - observable success criteria and important non-goals;
   - allowed tools, required inputs, expected outputs, and safety boundaries.
   If a trustworthy automated verifier cannot be derived from the request or the repository,
   ask the user for the missing success criteria. Never invent a verifier that merely checks for
   files or text produced by the candidate.
2. Inspect only the relevant project files with `list_dir`, `read_file`, or `read_files`. Reuse the
   canonical manifest shape from `skill-refinement/suites/suite.template.json`.
3. Create a host-owned suite at `skill-refinement/suites/<suite-id>/`:
   - `seed-skill.md`: the complete initial Skill, focused on reusable procedure rather than the
     examples' answers;
   - `suite.json`: a schema-version-1 manifest with `id`, `task`, `baseline`, `skillPath`,
     `rollouts`, `protectedPaths`, `evaluation`, and optional `templateModel` and
     `reflectionModel` references in `vendor[@interface][/model]` form.
   Use `write_files` so the seed and manifest are created together. Evaluation commands and model
   credentials must never be embedded in the Skill body.
4. Call `skill_refinement` with `list_suites`, then `refine` for the new suite. Inspect the returned
   ranking, verifier output, protected-path violations, and candidate content; do not judge a
   candidate from prose alone. The Rollouts verify the seed used for that run. A candidate returned
   by the reflection model is unverified until it is promoted and used as the next run's seed.
5. For recurrent improvement, checkpoint the current seed, promote the returned candidate to
   `seed-skill.md`, then run the same fixed suite again. Compare the pass count, protection
   violations, score, and change cost of verified seeds across generations. Stop when the current
   seed passes every Rollout, two consecutive generations show no verified improvement, or three
   generations have been evaluated. Never change the task, verifier, or protected paths merely to
   improve the score. Do not select the last newly generated candidate if no subsequent run has
   verified it.
6. When a stop condition is reached, place the best verified seed in the project-native
   `skills/<name>/` directory as `prompt.md` plus `index.js`, then run the relevant tests. The Skill
   registry discovers valid Skill directories dynamically, and the Skill RAG incrementally compiles
   them before its next search. Never overwrite an existing Skill without explicit user approval. Keep
   newer unverified candidates and all Rollout evidence only in the ignored refinement/runtime
   paths; list them separately instead of installing them.

## Output

Report the Skill contract, suite id, model roles, per-generation verified results, the installed
`skills/<name>/` path, and any remaining unverified behavior. Clearly distinguish a generated
candidate, a verified seed, and the installed Skill.
