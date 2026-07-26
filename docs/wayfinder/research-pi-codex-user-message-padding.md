# Research: Pi + Codex user message padding (mid-run)

Facts only. No product implementation. Companion to `research-pi-codex-user-interrupt-continue.md` (abort/resume). Sources: local `research/pi` (2026 tree) and OpenAI Codex App Server docs / CLI discussion.

## Executive answer

**Padding / steer is not abort.** Both systems let the user add more user text while a run is active. That text is **queued or appended into the same run/turn** and becomes visible to the model at a later safe point. **Interrupt/stop** cancels the in-flight generation (`abort` / `turn/interrupt`) and ends the turn as aborted/interrupted. Empty submits are blocked at the **interactive UI** layer in Pi; Codex app-server docs do not document empty-input rejection for `turn/steer`.

## Pi

### APIs and queues

| API | Role | Key files |
| --- | --- | --- |
| `Agent.steer(message)` | Enqueue for **mid-run** injection | `packages/agent/src/agent.ts` |
| `Agent.followUp(message)` | Enqueue for **after agent would stop** | same |
| `Agent.prompt(...)` while busy | **Throws** — must use steer/followUp | same |
| `Agent.abort()` | Cancel active `AbortController` | same |
| `getSteeringMessages` / `getFollowUpMessages` | Loop poll hooks | `packages/agent/src/types.ts`, `agent-loop.ts` |
| Session wrappers | `AgentSession.steer` / `followUp` / `prompt(..., { streamingBehavior })` | `packages/coding-agent/src/core/agent-session.ts` |
| Harness | `steer` / `followUp` / `nextTurn` + `abort` | `packages/agent/src/harness/agent-harness.ts`, `docs/agent-harness.md` |

Queue modes (`QueueMode`: `"one-at-a-time"` default, or `"all"`): drain one message or all at each poll (`PendingMessageQueue` in `agent.ts`).

### When input is injected (not mid-token, not mid-tool-batch)

Loop order (`agent-loop.ts` `runLoop`):

1. Poll **steering** at start of run and **after each turn** (after tools finish + `turn_end`).
2. Inject pending user messages into context, then stream the next assistant response.
3. If the assistant had tool calls, **execute the full tool batch first**. Steering does **not** cancel or skip remaining tools of that assistant message (types + README + tests: both tools complete before steer text appears).
4. When there are no more tools and no steering, poll **follow-up**. If any, inject and continue the outer loop; else `agent_end`.

So steer is **padding at the next turn boundary after the current tool batch**, not interruption of the provider stream and not mid-tool cancel.

### Interactive defaults

- **Enter** while streaming → `prompt(text, { streamingBehavior: "steer" })` (`interactive-mode.ts`).
- **Alt+Enter** / follow-up action → `streamingBehavior: "followUp"`.
- **Escape** while streaming → restore queued messages into the editor and **`agent.abort()`** — explicit interrupt path, not steer.
- Empty submit: `onSubmit` / follow-up handlers `trim()` and **return if empty**; core `steer`/`followUp` will happily enqueue empty text if called programmatically (no core empty-string guard).

### `nextTurn` (harness only)

`AgentHarness.nextTurn(text)` queues messages for the **next user-initiated** turn (inserted before the new user message). Survives **abort**; steer/follow-up queues are cleared on harness abort.

## Codex

### App-server (authoritative protocol)

From [Codex App Server](https://developers.openai.com/codex/app-server) (also mirrored in Chinese digest):

| Method | Behavior |
| --- | --- |
| `turn/start` | New user input + start generation; creates a turn |
| `turn/steer` | **Append user input to the active in-flight turn**; returns accepted `turnId`; **no new turn**; does **not** emit `turn/started`; does **not** accept turn-level overrides (model, cwd, sandbox, outputSchema); fails if no active turn; clients pass `expectedTurnId` matching the active turn |
| `turn/interrupt` | Cancel in-flight turn; success `{}`; turn ends with **`status: "interrupted"`**; still finishes via `turn/completed` |
| `thread/inject_items` | Append raw items to history **without** starting a user turn (different from steer) |

Lifecycle docs: “Steer an active turn” is listed as a first-class step between start and complete — padding into the **same** turn, not a stop.

### CLI / product UX (secondary)

- Steer mode (CLI experimental/history): type while agent works; message treated as **pending steer** and applied without Esc-killing the turn. Community/blog describe injection at a later thinking step; some app users report steer behaving more like **post-turn queue** than hard mid-thought insert.
- **Esc** / interrupt: stop generation (distinct from steer). Issues discuss Esc to **submit queued steering immediately** vs interrupt — UI-layer semantics, not app-server `turn/steer` itself.
- **Empty messages:** not documented on app-server for `turn/steer` / `turn/start`. No official guarantee found in protocol docs.

## Comparison table (steer/padding vs interrupt)

| Dimension | Pi | Codex |
| --- | --- | --- |
| Mid-run user text | `steer()` / `followUp()` queues | `turn/steer` appends to active turn |
| New turn vs same run | Same agent run; new **inner** turns after inject | Same **turn id**; no `turn/started` |
| Inject timing | After tool batch + turn_end (steer); after agent would stop (followUp) | Protocol: append while in-flight; exact provider-step timing not fully specified publicly |
| Concurrent `prompt` / new turn | Rejected while busy | `turn/start` is a new turn; steer is separate |
| Interrupt/stop | `agent.abort()` / Escape → `stopReason: "aborted"` | `turn/interrupt` → `status: "interrupted"` |
| Queues on abort | Harness clears steer/followUp; UI may restore text to editor | Interrupt ends turn; steer content already accepted stays turn-local per protocol |
| Empty message | UI blocks empty; core allows empty text | Not specified in app-server docs |

## What is NOT abort

- **Steer / follow-up / turn/steer / pending steer** — add user content; do not set aborted/interrupted solely by existing.
- **Queue mode drain** — delivery batching only.
- **`shouldStopAfterTurn`** (Pi) — graceful exit after turn_end **before** polling queues; does not abort the provider stream or tools already run.
- **`nextTurn`** (Pi harness) — deferred padding for the **next** user turn; survives abort.
- **`thread/inject_items`** (Codex) — history injection without a user turn or generation.
- **Empty editor Escape** (Pi) — double-Esc actions (`/tree`, `/fork` settings); not abort unless streaming.

**Is abort:** Pi `Agent.abort()` / Escape while streaming; Codex `turn/interrupt` / Esc-as-stop in TUI. Those cancel generation; they do not by themselves “pad” a follow-up (user must send again after idle, unless UI re-submits restored queue text).

## Sources

- Local: `research/pi/packages/agent/src/agent.ts`, `agent-loop.ts`, `types.ts`; `packages/agent/README.md`, `docs/agent-harness.md`, `CHANGELOG.md`; `packages/coding-agent/src/core/agent-session.ts`, `modes/interactive/interactive-mode.ts`; tests `agent-loop.test.ts` (tools complete before steer inject).
- Codex App Server: https://developers.openai.com/codex/app-server — lifecycle (`turn/steer`, `turn/interrupt`), method list, turn completion statuses.
- Secondary UX (not protocol): Codex CLI steer-mode writeups; GitHub issues on pending steer / Esc + queued messages; community notes on queue vs mid-turn insert behavior.
- Related note: `docs/wayfinder/research-pi-codex-user-interrupt-continue.md`.
