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
- Reflection model: the suite's `reflectionModel` reads the complete cleaned scored trajectory and
  returns a structured Skill Patch.
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
     `rollouts`, `epochs`, `stepsPerEpoch`, `protectedPaths`, `evaluation`, and optional `templateModel` and
     `reflectionModel` references in `vendor[@interface][/model]` form.
   Use `write_files` so the seed and manifest are created together. Evaluation commands and model
   credentials must never be embedded in the Skill body.
4. Call `skill_refinement` with `list_suites`, then call `refine` once for the new suite. That call
   owns all configured epochs, steps, parallel batches, structured edits, verification, and
   temporary Git versions. Inspect every returned step, verifier output, protected-path violation,
   score, and acceptance reason; do not judge a patch from prose alone. A tie or regression is
   rejected, and only a candidate whose aggregate batch score is strictly greater than the current
   verified Skill is committed. Never change the task, verifier, or protected paths merely to
   improve the score.
5. Place the returned best verified Skill in the project-native
   `skills/<name>/` directory as `prompt.md` plus `index.js`, then run the relevant tests. The Skill
   registry discovers valid Skill directories dynamically, and the Skill RAG incrementally compiles
   them before its next search. Never overwrite an existing Skill without explicit user approval.
   Keep rejected candidates, transport attempts, raw/cleaned trajectories, and the exported
   temporary Git history only in the ignored refinement/runtime paths.

## Output

Report the Skill contract, suite id, model API roles, per-step verified scores and acceptance
decisions, the installed `skills/<name>/` path, and any remaining unverified behavior. Clearly
distinguish rejected patches, the best verified Skill, and the installed Skill.
