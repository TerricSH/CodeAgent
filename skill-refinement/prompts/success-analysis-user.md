# Current Skill
{{skill}}

# Optimization position
Epoch {{epoch}}, step {{step}}, training batch {{batch}}, success minibatch {{minibatch}}

# Provisional edit cap
{{editBudget}}

# Optimizer-only meta guidance
{{metaSkill}}

# Epoch-local rejected-edit feedback
{{rejectedBuffer}}

# Successful scored trajectories
{{evidence}}

Identify behavior patterns common across successful trajectories that are not already protected by
the Skill. Propose only concise edits needed to preserve or generalize those behaviors. Set
source_type to "success". Do not invent corrections from successful evidence.
