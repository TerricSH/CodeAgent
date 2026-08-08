## Skill activation

Use `activate_skill` only with a candidate returned by `skill_search`. Multiple Skills may remain active when each contributes to the current task. Their bodies are independent Context cache nodes and are subject to the same measured Token budget as other dynamic data.

Use `deactivate_skill` when a Skill is irrelevant or conflicts with the task. Include a concise reason so the failed selection remains auditable before another Skill search.
