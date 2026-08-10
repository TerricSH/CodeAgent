# Verification Gate

The verification gate controls completion of a Runtime Trace. It does not own or modify
`task-ledger` items.

Activate it with `<verification-gate mode="required"/>` in the base system instruction or raw
current user request, or use the `declare` action for an explicit natural-language requirement.
The Runtime parses the marker into immutable Trace policy before composing model-facing prompts.
Propose the complete plan before effectful tools run:

```json
{
  "action": "plan",
  "checks": [
    { "id": "tests", "type": "command", "command": "npm test" },
    { "id": "artifact", "type": "file", "path": "result.txt", "nonEmpty": true },
    {
      "id": "manifest",
      "type": "json",
      "path": "result.json",
      "assertions": [{ "pointer": "/ok", "valueType": "boolean", "equals": true }]
    }
  ]
}
```

Model-proposed plans require an exact approval through the host's direct interaction channel.
Alternatively, a governing marker can name a host-configured profile, for example
`<verification-gate mode="required" profile="release"/>`. Plans are immutable and conjunctive:
every check must pass. The Runtime completion-authorizer reruns the whole plan before it renders or
commits the candidate final reply. A failed or inconclusive result continues the Agent loop. Only
an exact interactive user approval can create a one-use override tied to the active Trace and gate
binding.

The Runtime Tool registry invokes generic whole-batch and per-tool pre-execution hooks with internal
`effects` metadata (`read`, `control`, `write`, `execute`, or `external`). A plan proposal and write
in one parallel batch are both rejected from the same preflight snapshot. The gate does not call or
inspect `task-ledger`.

The reusable engine and provider registry live in `verification-core/`. Docker and model verdicts
are not dependencies and cannot authorize completion.

Additional deterministic providers can be supplied in the plugin configuration. A provider exports
`{ type, verify(check, runtime) }`; custom checks carry provider-specific JSON under `config` and do
not require changes to the plan or engine implementation. Full check evidence is written to Audit;
the extension state retains only compact status summaries and Audit event references.

Trace policy is isolated across delegation boundaries. Internal delegation payloads are started with
`policySource: "internal"`, so a marker copied inside `currentUserInstruction` cannot activate the
child gate. A child Trace can still activate its own gate through its own base-system declaration,
an explicit host-provided `tracePolicy`, or an independent agent declaration.
