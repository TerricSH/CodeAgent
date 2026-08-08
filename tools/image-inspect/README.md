# Image Inspect Tool

`image_inspect` is a standalone core Tool for visual screenshot analysis. It does not reuse or
switch the current conversation model and has no dependency on RAG, Skill Refinement, plugins, or
the runtime model resolver.

## Configuration

The Tool uses an independent OpenAI-compatible vision endpoint. Set these values in `.env`:

```env
VISION_API_KEY=your-vision-provider-key
VISION_API_BASE_URL=https://vision-provider.example/v1
VISION_MODEL=your-vision-model
```

Connection field names and input limits are declared in `config.json`. Secrets are read only from
environment variables and are never returned by `status`.

All model instructions live under `prompts/`; `service.js` only loads and renders those templates.

## Actions

- `status`: validate that the external endpoint, key, and model are configured.
- `analyze`: upload one or more Workspace images and answer a visual question.
- `verify`: inspect explicit criteria and return normalized checks, visible evidence, confidence,
  and a code-computed overall result.

Supported inputs are PNG, JPEG, WebP, and GIF, detected from file signatures rather than filename
extensions. Source paths are resolved through the narrow `fileSystem` runtime capability. The Tool
does not persist images or model responses.

The external model is not treated as a deterministic verifier. A check passes only when the model
returns `passed: true` and meets the configured request's confidence threshold; missing or malformed
checks fail closed. Returned analysis and evidence are marked `untrusted-external-model-output` and
must never be interpreted as Agent instructions.
