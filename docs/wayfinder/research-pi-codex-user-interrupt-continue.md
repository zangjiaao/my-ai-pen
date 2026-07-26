# Research: Pi + Codex user interrupt and continue

Facts only. No product implementation. Sources: local `research/pi` tree and public OpenAI Codex docs / CLI references (2026).

## Executive answer

Both systems treat **user interrupt as cooperative cancel of the in-flight turn**, not session teardown. Transcript (and partial assistant content where available) remains; the user can send another message or resume the same session. Neither system “resumes a provider stream mid-token”; continue means **new turn(s) over preserved history**.

| Concern | Pi | Codex |
| --- | --- | --- |
| Primary cancel API | `AbortSignal` / `agent.abort()` | `turn/interrupt` (app-server); TUI interrupt (Esc in community/issues) |
| Turn outcome | `stopReason: "aborted"` | turn `status: "interrupted"` |
| Session after interrupt | Same session idle; prompt again | Same thread; resume/continue commands |
| Mid-run steer | `steer()` / `followUp()` queues | `turn/steer` |
| Crash vs abort | Durable harness marks interrupted; provider stream not resumable | Session JSONL on disk; rehydrate from transcript |

## Pi (with file paths / symbols)

### Signals / APIs

- **Core:** each run creates `AbortController`; `Agent.abort()` aborts the active signal (`research/pi/packages/agent/src/agent.ts` — `abort()`, `signal`, `runWithLifecycle`).
- **Stream layer:** providers take `signal`; aborted responses surface `stopReason === "aborted"` and partial `content` (`research/pi/packages/ai/README.md` — Aborting Requests / Continuing After Abort).
- **Agent loop:** on `stopReason` `error` | `aborted`, ends turn immediately (`agent-loop.ts` ~196–199). Tools receive `signal`; aborted prep yields tool result `"Operation aborted"` (~591–611); sequential batches break after abort (~440–442).
- **Interactive UI defaults** (`coding-agent/docs/keybindings.md`):
  - `app.interrupt` → **Escape** — cancel / abort while streaming
  - `app.clear` → **Ctrl+C** — clear editor (not agent abort by default)
  - `app.exit` → **Ctrl+D** when editor empty
- Escape while streaming calls `restoreQueuedMessagesToEditor({ abort: true })` → `agent.abort()` (`interactive-mode.ts` ~2452–2456, ~3828–3845). Also aborts bash / compaction / retry when those own Escape.
- **RPC:** `{"type":"abort"}` (`coding-agent/docs/rpc.md`); SDK `AgentSession.abort()` (`docs/sdk.md`).
- **Empty message / Ctrl+C** are not the agent-interrupt path; interrupt is explicit Escape / `abort`.

### State, tools, queues, subagents

- Abort **does not** wipe the transcript. Partial assistant messages with `stopReason: "aborted"` stay in context; UI shows abort text (`assistant-message.ts` ~129–133).
- **Harness abort** clears steer/follow-up queues and returns cleared messages (`agent-harness.ts` `abort()` ~970–996; `agent-harness.md` Abort section). Interactive mode **restores queued text into the editor** before abort.
- **`nextTurn()` messages survive abort** (harness docs); they inject on the next user-initiated turn (`agent-session.ts` ~1105–1109).
- Pending session writes are not discarded on abort (flush at next save point / `agent_end` / failure cleanup) — harness docs.
- Tools must honor `AbortSignal` (exec/fs Node env checks `aborted`). Parallel tool start can still race until signal is observed.
- Durable recovery policy: unfinished turn / provider request → **mark interrupted**; unfinished tool → interrupted/error result unless tool declares retry-safe (`durable-harness.md` ~134–142). **Provider streams are not resumable.**

### Continue same session after interrupt

Yes, same process and same session file:

1. User aborts → agent returns idle (`waitForIdle` / `finishRun`).
2. User sends a new prompt (normal chat). AI layer documents: push aborted partial + `"Please continue"` and call complete again (`ai/README.md` Continuing After Abort).
3. API `Agent.continue()` continues only if last message is **user or toolResult**, or if steer/follow-up queues have items; cannot continue from a bare assistant tail without queues (`agent.ts` ~337–365). After a clean abort, last message is usually **assistant/aborted**, so product path is **new user message**, not bare `continue()`.
4. Session persistence: `pi -c` / `--continue`, `pi -r` / `--resume`, `/resume`, `/tree`, `/fork`, `/clone` (`coding-agent/docs/sessions.md`, `usage.md`). Sessions are JSONL trees under `~/.pi/agent/sessions/`. Resume reloads transcript + leaf, not an in-flight provider stream.

## Codex (with URLs)

### Interrupt / stop generation

- **App Server:** `turn/interrupt` cancels the in-flight turn; success is `{}`; turn ends with **`status: "interrupted"`**. Completion still emits `turn/completed` after interrupt. `turn/steer` appends user input to the active turn.  
  https://developers.openai.com/codex/app-server
- **Config:** `agents.interrupt_message` (bool, default **true**) — record a **model-visible** message when an agent turn is interrupted.  
  https://developers.openai.com/codex/config-reference
- **Hooks:** `Stop` (and related turn-scoped hooks) run when a turn stops; can validate / inject continue behavior.  
  https://developers.openai.com/codex/hooks
- **Goals:** stopping conditions include interruption; interruptions **pause** the objective; resuming a thread can restore it.  
  https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
- **Changelog:** e.g. keep interrupted prompts in conversation history (PR #33198 referenced on Codex changelog).  
  https://developers.openai.com/codex/changelog
- CLI TUI interrupt key is widely described as **Esc** in issues/community discussion; official keyboard tables emphasize app shortcuts more than a single “stop generation” doc page. Treat Esc as observed product UX, confirmed in GitHub discussion, not as a fully documented app-server field.

### Continue / resume after interrupt

- Sessions auto-persist (commonly described as JSONL under `~/.codex/sessions/`). Closing the terminal does not delete history; reopen reconstructs context from transcript.
- CLI patterns (documented / widely verified against Codex CLI references):
  - `codex continue` — most recent interactive session (cwd-scoped)
  - `codex resume` / `codex resume --last` — picker or last session
  - In-session `/resume`, `/fork`
  - Non-interactive: `codex exec --last` / resume-session-id style flags  
  Secondary writeup cross-checking official CLI pages: https://www.verdent.ai/guides/codex-cli-resume-continue-save-chat  
  Related: https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions
- Resume **rehydrates conversation history**, not frozen model activations. Mid-task interrupt expects the model to reorient from transcript (and optional user “continue from X” prompt).
- Multi-agent: `resume_agent` among collaboration tools when `features.multi_agent` is on (config reference).

## Comparison table

| Dimension | Pi | Codex |
| --- | --- | --- |
| Cancel primitive | `AbortController` + `abort()` | `turn/interrupt` |
| Visible stop reason | `stopReason: "aborted"` | turn `interrupted` |
| Partial assistant text | Kept when stream emitted partials | Interrupted history kept (changelog / interrupt_message) |
| Queued user input on cancel | Harness clears queues; UI restores to editor | Steer API separate; config records interrupt message |
| Same-session continue | New prompt after idle; session JSONL | New turn; `codex continue` / `thread/resume` |
| Cross-process resume | `-c` / `-r` / `/resume` / tree | `continue` / `resume` / app-server `thread/resume` |
| Provider mid-stream resume | No | No (reconstruct from transcript) |

## Relevance to product: abort vs package-fail; continue-chat after abort

- **Abort ≠ package-fail.** Abort is **user (or host) cooperative cancellation** of the current agent turn: signal fired, tools asked to stop, turn ends with an explicit aborted/interrupted outcome, session remains. Package-fail is a **runtime/deployment/tooling failure** (process death, install error, dependency missing)—different recovery surface. Pi’s durable harness even treats crash recovery as “mark interrupted” rather than inventing success.
- **Continue-chat after abort is the normal path** in both systems: remain on the same session/thread, keep history (including partial/aborted assistant turns), accept the next user message. Optional model-visible interrupt marker (Codex `agents.interrupt_message`) improves reorientation; Pi relies on aborted assistant messages + user text in transcript.
- Product implication for Node/platform bindings: expose cancel as **turn-scoped AbortSignal**, persist aborted turns in session state, and allow the next chat message on the same task without requiring a new task ID—matching both reference agents. Do not equate abort with task failure gates or expert-graph package failure.

## Sources

**Pi (local)**

- `research/pi/packages/agent/src/agent.ts` — `abort`, `continue`, queues, lifecycle
- `research/pi/packages/agent/src/agent-loop.ts` — aborted stop, tool abort
- `research/pi/packages/agent/src/harness/agent-harness.ts` — harness `abort()`
- `research/pi/packages/agent/docs/agent-harness.md`, `durable-harness.md`
- `research/pi/packages/ai/README.md` — abort + continue examples
- `research/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts` — Escape interrupt
- `research/pi/packages/coding-agent/docs/keybindings.md`, `sessions.md`, `rpc.md`, `sdk.md`

**Codex (web)**

- https://developers.openai.com/codex/app-server — `turn/interrupt`, `turn/steer`, `thread/resume`
- https://developers.openai.com/codex/config-reference — `agents.interrupt_message`
- https://developers.openai.com/codex/hooks — Stop hooks
- https://developers.openai.com/codex/changelog
- https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex — interrupt pauses goals
- https://www.verdent.ai/guides/codex-cli-resume-continue-save-chat — CLI continue/resume survey
- https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions — `codex resume --last`
