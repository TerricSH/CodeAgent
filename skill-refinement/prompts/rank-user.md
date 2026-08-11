# Current Skill
{{skill}}

# Maximum edits (textual learning rate)
{{editBudget}}

# Optimizer-only meta guidance
{{metaSkill}}

# Epoch-local rejected-edit feedback
{{rejectedBuffer}}

# Merged edit pool
{{patch}}

Rank only edits from the supplied pool by expected validation utility. Prefer independently
supported recurring corrections, account for rejected-edit feedback, and preserve successful
behavior. Return at most {{editBudget}} edits. Do not invent new edits and do not rewrite the Skill.
