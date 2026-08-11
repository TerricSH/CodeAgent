# Previous epoch-end Skill
{{previousSkill}}

# Current epoch fast-update Skill
{{currentSkill}}

# Same-task longitudinal comparison
{{comparison}}

# Optimizer-only meta guidance
{{metaSkill}}

Write a concise block of durable procedural guidance supported by cross-epoch evidence. Focus on
regressions, persistent failures, improvements worth retaining, and stable successes. Do not copy
task-specific answers. This block is the only content allowed inside the protected SLOW_UPDATE
region. Return exactly:

{"reasoning":"brief explanation","slow_update_content":"markdown guidance"}
