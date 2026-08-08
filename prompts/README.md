# Runtime Prompt Files

Runtime prompts sent to models belong in Markdown files, not JavaScript literals. JavaScript may
load a prompt, inject runtime data into declared placeholders, and pass the rendered result to a
model or `Context`.

`loader.js` supports ordinary placeholders and optional blocks:

```md
Hello {{name}}.
{{#details}}Details: {{details}}{{/details}}
```

System prompt ownership remains local to each subsystem:

- `prompts/system-policy.md`: main Agent policy.
- `agents/*/prompt.md`: subagent system prompts.
- `plugins/auto-compaction/prompts/summary-system.md`: compaction model.
- `plugins/memory/prompts/*-system.md`: memory overlays.
- `plugins/ask-user/prompts/history-system.md`: collected user facts.
- `skill-refinement/prompts/*-system.md`: Rollout and reflection models.
- `tools/activate-skill/prompts/active-skill-system.md`: activated Skill wrapper.
- `tools/image-inspect/prompts/system.md`: external vision model.

Tool and Skill prompt files were already external and remain colocated with their owners. The
static regression test in `test/system-prompts.test.js` rejects direct system-prompt literals in
production JavaScript.
