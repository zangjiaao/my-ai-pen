# Agent Engineering Rules

**Spec precedence (when documents disagree):** `AGENTS.md` → `docs/prd.md` → `docs/specs/harness.md` (candidate-specific) → other `docs/specs/*` / `docs/v1-delivery.md`.

**Runtime candidates (pre-PK):** `node4/` and `node5/` are **co-equal Node implementation candidates**. The platform binds to **exactly one** candidate per deployment; documentation does **not** declare a winner. **Legacy** `node/`, `node2/`, `node3/`: plan-delete after gates — do not expand product behavior there. **`research/`**: frozen third-party reference (not product). **`benchmarks/`**: frozen lab evaluation assets (not product authority). Product work targets platform + the bound candidate + `experts/`.

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

## Documentation Maintenance

- **Keep docs current with code.** When you change product behavior, runtime layout, expert packs, install/uninstall, APIs, or default policies, update the matching living docs in the **same change** (or immediately after), not as a vague follow-up.
- **Living sources (edit these):** `docs/prd.md`, `docs/v1-delivery.md`, `docs/specs/*`, `docs/design.md` (UI only), `docs/README.md`, `docs/project-cleanup-plan.md` (ops), `docs/agents/*` (skill process), `experts/README.md`, and this file. Prefer small surgical updates over new parallel docs.
- **Do not invent archive trees** for obsolete plans — hard-delete when done (git history is backup).
- **Remove leftovers:** if you migrate files (e.g. skills/recipes into `experts/`), delete or replace old paths under a Node candidate with a short pointer README so agents do not follow stale locations.
- **Index and discoverability:** when adding a new living doc, link it from `docs/README.md` (and `experts/README.md` when pack-related).
- **Accuracy over volume:** document what the system **actually** does now (platform + bound Node candidate + experts). Do not declare a PK winner in living docs.
- **Frozen trees:** do not delete or relocate `research/` or `benchmarks/` without an explicit new decision.
- **Commits:** include doc updates in the same commit as the behavioral change when practical so history stays reviewable.

## Harness Over Restriction

- Do not use target-specific profiles, benchmark expectations, expected vulnerability counts, fixed vulnerability lists, or site-identification logic to simulate security testing ability.
- Do not make new gates, restrictions, tools, or validators the default answer to weak agent behavior. First improve the agent's normal decision path through prompts, task shaping, memory semantics, and role definitions.
- Do not hardcode current-task workflows, vulnerability categories, payloads, reports, or coverage conclusions unless the user explicitly approves that tradeoff.
- Prefer harness steering over late failure handling: guide agents toward attack-surface discovery, hypothesis-driven testing, candidate validation, and reporting in that order.
- Validator and reporting agents should follow candidate evidence from discovery/testing work. They must not replace discovery-oriented testing or become the first post-recon workstream.

## Intent And Workflow Selection

- Do not route user tasks, choose pi-workflows, or set engagement modes by keyword/regex matching on the user's natural-language prompt (including bilingual synonym lists that try to "guess" intent).
- Prefer the LLM (or an explicit structured field from the product UI / task envelope such as `engagement`) to understand the user's intent and select the matching workflow.
- Platform code may map an **explicit** structured engagement value to a workflow name and completion gates. It must not invent that engagement by scanning free-text instructions for words like "verify", "retest", or "explain".
- After the agent runs a workflow, gates and reports should follow the **actually selected workflow / persisted engagement**, not a second keyword pass over the original prompt.
- When intent is ambiguous and no structured engagement is provided, the agent should decide among published workflows using judgment; defaults in code (if any) must be conservative and disclosed, not disguised NLP.
