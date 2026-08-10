# Model providers

Models are addressed as `vendor[@interface][/model]`. The same runtime is used by the main agent,
Skill Refinement's execution model, and its reflection model. A reference can therefore target a
cloud API or a local HTTP server without changing SkillOpt code.

Example local OpenAI-compatible endpoint:

```json
{
  "vendors": {
    "local": {
      "interfaces": {
        "openai": {
          "apiKey": "local",
          "baseURL": "http://127.0.0.1:11434/v1",
          "reasoningRequired": true,
          "models": {
            "reasoning-model": {
              "maxContextTokens": 32768,
              "maxOutputTokens": 4096
            }
          }
        }
      }
    }
  }
}
```

The corresponding suite reference is `local@openai/reasoning-model`. Use the URL, model name, and
authentication expected by the actual local service.

All interfaces normalize streaming output to `thinking`, `content`, and `tool_calls`. Skill
Refinement requires a non-empty `thinking` stream for every successful model call. It enables
standard reasoning options automatically:

- OpenAI-compatible Chat Completions: `reasoning_effort`;
- OpenAI Responses: `reasoning.effort` plus `reasoning.summary`;
- Anthropic Messages: extended `thinking` with a token budget.

`requestOptions` may be set at the interface or individual model entry to override these defaults
for a provider-specific protocol. Keep credentials in environment variables through `apiKeyEnv`;
request options and model metadata are not a credential store.
