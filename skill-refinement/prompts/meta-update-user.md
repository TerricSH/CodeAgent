# Previous optimizer meta skill
{{metaSkill}}

# Epoch optimization history
{{history}}

# Epoch-local rejected feedback
{{rejectedBuffer}}

Update optimizer-only guidance for future reflection, merging, and ranking. Summarize edit patterns
that improved validation, edits that were rejected, and failures that persisted. Remove guidance
contradicted by this epoch. Do not emit task-execution instructions for the deployed Skill. Return:

{"reasoning":"brief optimizer reflection","meta_skill_content":"compact optimizer guidance"}
