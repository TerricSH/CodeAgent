# Skill-R1 conformance reference

Use this reference only for requests that explicitly mention Skill-R1 or require a conformance
claim. The normative algorithm source is *Skill-R1: Agent Skill Evolution via Reinforcement
Learning*, arXiv:2605.09359v1 (10 May 2026): <https://arxiv.org/abs/2605.09359>.

## Mandatory architecture

A full Skill-R1 implementation has all of these distinct components:

- a task distribution over instances `x` and an instance-level initial skill bank `B_x`;
- a frozen task LLM that produces task trajectories conditioned on the same task instance and the
  current skill;
- a separate, trainable lightweight skill generator (editor policy) `pi_theta`;
- a fixed verifier that maps each task rollout to a scalar reward;
- an instance-specific history containing prior skills, rollout groups, and verified outcomes.

The task LLM is never updated. Full Skill-R1 updates the skill generator's parameters. A reflection
model that only returns textual patches through inference is not a trainable skill generator.

## Recurrent data-collection loop

For each task instance:

1. Select initial skill `s_0` from `B_x`.
2. Under the shared conditioning `(x, s_0)`, sample a group of K rollouts from the frozen task LLM,
   verify each rollout, and initialize the instance-specific history.
3. For each generation `g = 1..G`, sample the next skill from the skill generator conditioned on
   the same task instance and the accumulated history.
4. Under `(x, s_g)`, sample another group of K task rollouts, verify every rollout, and append the
   skill, rollout group, and rewards to that instance's history.

Independent dataset batches, one rollout per task, or revisions of one global Skill across
unrelated tasks do not implement this same-instance, multi-generation group process.

## Bi-level credit assignment

For reward `r_g_i` from rollout `i` in generation `g`, compute:

- intra-generation advantage: `A_intra(g,i) = r_g_i - mean_i(r_g_i)`;
- inter-generation advantage: `A_inter(g) = mean_i(r_g_i) - mean_i(r_(g-1)_i)`, with
  `A_inter(1) = 0`;
- combined advantage: `A(g,i) = A_intra(g,i) + lambda * A_inter(g)`.

Train the skill generator over accumulated generations with the paper's clipped GRPO surrogate,
using policy importance ratios and a KL penalty against a reference policy. Merely calculating
reward deltas, ranking candidate text, or accepting a patch after held-out evaluation does not
perform this policy update.

## Claims and variants

Use these labels precisely:

- **Full Skill-R1**: the mandatory architecture, recurrent group loop, bi-level advantages, and
  actual clipped GRPO parameter updates are all present.
- **Skill-R1 inference setup**: the same-instance recurrent group loop and history are present, but
  the editor is frozen and no gradient-based learning occurs. Label it as inference-only, never as
  the trained method.
- **Not Skill-R1**: selection-gated textual patches, one-shot reflection, ordinary prompt
  optimization, or other methods missing the recurrent group loop or generator training.

The project's current `skill_refinement` Tool is intentionally a SkillOpt implementation. Its
train/selection/test split, reflection patches, strict selection gate, and temporary Skill history
are useful for inference-time Skill optimization, but they are not substitutes for Skill-R1's
instance-level grouped generations or bi-level GRPO training.

## Audit output

For each mandatory requirement, report `present`, `partial`, or `missing` with a concrete file and
behavioral trace. Then state one of the three labels above. Do not infer conformance from names,
comments, prompts, schemas, or tests that only check for terminology.
