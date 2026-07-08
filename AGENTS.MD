# Agent Engineering Rules

## No Hardcoded Behavior Without Approval

- Do not hardcode user-visible workflow text, tool progress text, security findings, attack-surface assumptions, coverage conclusions, or product behavior to simulate intelligent agent behavior.
- Prefer deriving behavior from real agent output, persisted workflow state, structured task data, configuration, prompts, templates, or explicit user input.
- If a hardcoded mapping, fallback string, fixture, allowlist, denylist, or special-case branch appears necessary, explain why it is necessary and ask the user for approval before implementing it.
- Hardcoded test fixtures are acceptable only when they test a deterministic contract rather than replace production behavior.
- Do not convert raw tool arguments such as shell commands, URLs, payloads, or browser commands into user-facing narration unless the user explicitly asks to see those details.

## Agent Progress Communication

- Progress shown to users should represent the agent's real next-step intent or workflow state, not a mechanical paraphrase of the next tool call.
- Do not emit messages like `Next: Running command: ...` as a substitute for planning or status reporting.
- If the implementation needs agents to explain what they are about to do, design the flow so that the explanation comes from the agent's planning/workflow layer or persisted state, not from a platform-side hardcoded tool-name-to-message table.

## Implementation Discipline

- When fixing behavior, inspect the existing architecture first and identify the source of truth before adding new branches.
- Keep changes scoped and avoid hiding design problems behind presentation-layer patches.
- Before adding a workaround, ask whether it should be a temporary patch, a feature flag, or a proper architectural change.

## Harness Over Restriction

- Do not use target-specific profiles, benchmark expectations, expected vulnerability counts, fixed vulnerability lists, or site-identification logic to simulate security testing ability.
- Do not make new gates, restrictions, tools, or validators the default answer to weak agent behavior. First improve the agent's normal decision path through prompts, task shaping, memory semantics, and role definitions.
- Do not hardcode current-task workflows, vulnerability categories, payloads, reports, or coverage conclusions unless the user explicitly approves that tradeoff.
- Prefer harness steering over late failure handling: guide agents toward attack-surface discovery, hypothesis-driven testing, candidate validation, and reporting in that order.
- Validator and reporting agents should follow candidate evidence from discovery/testing work. They must not replace discovery-oriented testing or become the first post-recon workstream.
