Create or update reusable project Skills. Use this Skill when no installed Skill fits the task or
an existing Skill needs improvement. Produce the smallest reviewable Skill that captures reusable,
non-obvious procedure; do not encode the answers to evaluation examples.

This project stores a Skill in `skills/<name>/` as `prompt.md` plus `index.js`. Follow that native
contract. Add `references/`, `scripts/`, or `assets/` only when they reduce repetition or keep the
main prompt concise. Do not add auxiliary README, installation, changelog, or process files.

## Algorithm identity

The available `skill_refinement` Tool implements inference-time SkillOpt: a frozen task model
collects scored evidence, a reflection model proposes bounded textual patches, and a fixed
selection split gates acceptance. It is not Skill-R1 and it does not train model weights.

When the user explicitly requests Skill-R1, asks whether an integration conforms to Skill-R1, or
asks to label a workflow as Skill-R1, first read
`skills/skill-creator/references/skill-r1.md`. Compare the implementation with every mandatory
requirement there and report the missing requirements before changing code. Never relabel
selection-gated prompt editing or ordinary reflection as Skill-R1. Treat implementation of a
trainable generator and its optimization loop as separate architecture/training work, not as an
implicit part of creating a Skill.

## Roles in the supported SkillOpt path

- Creator: define the Skill contract and write or revise the seed.
- Task model: the suite's `templateModel` executes isolated task Rollouts conditioned on the
  current Skill and stays frozen during refinement.
- Verifier: the fixed `evaluation.command` supplies observable rewards. Never let a candidate edit
  the verifier, datasets, or protected paths.
- Reflection model: the suite's `reflectionModel` analyzes separate success and failure
  minibatches, merges and ranks proposals, and returns a bounded structured Skill Patch.
- `skill_refinement`: own Rollout isolation, evaluation, ranking, model resolution, and artifacts.
  Do not reproduce these responsibilities in the Skill body.

## Workflow

1. Establish the contract with concrete examples:
   - choose a lowercase kebab-case name and a concise trigger description;
   - identify representative requests, including difficult and failure-prone cases;
   - specify observable success criteria, non-goals, required inputs and outputs, allowed tools,
     and safety boundaries;
   - inspect an existing Skill before updating it and preserve useful behavior.
   If the request and repository do not establish a trustworthy verifier, ask for the missing
   success criteria. Never invent a verifier that only checks for files or expected phrases.
2. Plan only reusable contents. Keep essential procedure in `prompt.md`; put detailed domain
   material in a directly linked reference, deterministic repeated operations in tested scripts,
   and output resources in assets. Avoid duplication between the prompt and references.
3. Write or update the project-native Skill. Never overwrite an existing Skill without explicit
   user approval. Keep the trigger description specific enough to activate for intended requests
   and avoid unrelated requests.
4. When verified refinement is requested and a valid suite can be built, reuse
   `skill-refinement/suites/suite.template.json`. Create `seed-skill.md` and a schema-version-2
   `suite.json` with disjoint `dataset.train`, `dataset.selection`, and `dataset.test` items,
   `optimizer`, `protectedPaths`, `evaluation`, and optional `templateModel` and
   `reflectionModel` references in `vendor[@interface][/model]` form. Keep credentials out of the
   suite and Skill.
5. Call `skill_refinement` with `list_suites`, then call `refine` once. That call owns all epochs,
   batches, patches, verification, and temporary Git versions. Inspect verifier evidence,
   protected-path violations, scores, and acceptance reasons. Only a candidate whose mean score on
   the fixed selection split is strictly greater than the current verified Skill is accepted. The
   test split is used only for final reporting. Never alter data membership, the verifier, or
   protected paths to improve a score.
6. Place the returned best verified Skill in `skills/<name>/`, then validate registry loading and
   run relevant tests. Keep rejected candidates, transport attempts, trajectories, and temporary
   Git history only in ignored refinement/runtime paths. For complex changes, forward-test on
   realistic requests without exposing expected answers when a safe isolated evaluator is
   available.

## Output

Report the Skill contract, changed files, validation evidence, and remaining unverified behavior.
If SkillOpt refinement ran, also report the suite id, model roles, per-step scores and acceptance
decisions, and distinguish rejected patches from the best verified and installed Skill. If the
request concerns Skill-R1, report conformance separately and never imply that passing ordinary
Skill tests proves the Skill-R1 training algorithm is implemented.
