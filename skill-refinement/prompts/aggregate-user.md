# Current Skill
{{skill}}

# Merge stage
{{stage}}

# Optimizer-only meta guidance
{{metaSkill}}

# Epoch-local rejected-edit feedback
{{rejectedBuffer}}

# Patch proposals
{{patches}}

Merge these proposals hierarchically. Combine independent support counts, remove duplicates,
resolve conflicting targets, and discard example-specific edits. During the final merge, failure
corrections take priority over success reinforcement when they conflict. Return one Patch JSON
object only; do not apply an edit budget yet.
