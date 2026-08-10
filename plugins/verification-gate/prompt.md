# verification_gate

Use this tool when the effective system instruction or current user request explicitly requires strong verification.

- The structured required marker in the governing instruction is an authoritative strong-verification declaration.
- Call `declare` for an explicit natural-language request for strong verification.
- Before any write, command execution, or external side effect, call `plan` with the complete deterministic checks.
- `plan` is a proposal, not self-authorization: the host asks the user directly to approve the exact normalized plan. A configured profile may instead be selected by the governing structured marker.
- An approved or profile-bound plan is permanently frozen. It cannot be weakened, replaced, or deleted.
- All checks must pass. Model judgment and subagent verdicts are not verification evidence.
- The Runtime automatically reruns the entire plan and withholds the final reply until completion is authorized.
- Use `request_override` only when the user explicitly asks to cancel strong verification. The user must approve through the interactive prompt.
