# Current Skill
{{skill}}

# Optimization position
Epoch {{epoch}}, step {{step}}, training batch {{batch}}, failure minibatch {{minibatch}}

# Provisional edit cap
{{editBudget}}

# Optimizer-only meta guidance
{{metaSkill}}

# Epoch-local rejected-edit feedback
{{rejectedBuffer}}

# Failed scored trajectories
{{evidence}}

Identify recurring failure patterns across this minibatch. Propose only corrective Skill edits that
address common, reusable causes. Set source_type to "failure". You may propose fewer than the edit
budget and may return no edits.
