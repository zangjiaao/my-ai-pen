# Research: Codex session survival after interrupt

Facts only. Primary sources: OpenAI Codex App Server, Config Reference, Hooks, Non-interactive mode, Subagents, Responses multi-agent, and related official docs (2026). No product implementation advice.

## Executive answer

**User interrupt cancels the in-flight turn; it does not destroy the thread/session.**

In app-server terms, `turn/interrupt` requests cancellation of an active turn. On success the turn ends with `status: "interrupted"` and the server still emits `turn/completed` with that status. The **thread id stays the same**. Prior turns, items already written to the thread’s persisted JSONL rollout, goals, and metadata remain. The next user message is a new `turn/start` on that same thread (or, after unload, `thread/resume` then `turn/start`).

Interrupt is **not** process exit, **not** `thread/delete`, **not** `thread/archive`, and **not** the same as unloading a thread from memory (`thread/unsubscribe` → grace period → `thread/closed`). Compaction (`thread/compact/start` / auto-compact) is a separate history-shrinking path; it is not what interrupt does.

## Turn vs session/thread

| Layer | What it is | What interrupt does |
| --- | --- | --- |
| **Turn** | One user request + agent work (items, tool runs, streaming). Status: `inProgress` → `completed` \| `interrupted` \| `failed`. | Cancels generation. Ends with `interrupted`. Pending server requests (e.g. tool user-input) are cleared. |
| **Thread** | Conversation container: turns, items, goal, name, cwd/sandbox defaults, rollout file. Identified by `thread.id`. | Survives. Same id; later turns append. |
| **Session tree** | `thread.sessionId` is the live session-tree root. Root threads use their own id; forked threads keep the root’s session id. Spawned subagents are descendant threads (`parentThreadId` / `ancestorThreadId` filters; archive/delete cascade to descendants). | Interrupt does not delete the session tree. Teardown of descendants is via close/archive/delete tooling, not `turn/interrupt`. |
| **In-memory load** | Thread may be loaded (subscribed) or only on disk (`status.type: notLoaded`). | Interrupt does not unload. Unload is last-subscriber inactivity (~30 minutes) after `thread/unsubscribe`, or explicit archive/delete/process end. |
| **Process / client exit** | App-server or CLI process ends. | History remains on disk as the thread JSONL rollout (and optional `history.jsonl` index under `CODEX_HOME`). Reopen uses `thread/resume` / `codex resume` / `codex exec resume`, not mid-stream continuation. |

Core primitives (app-server): **Thread** → **Turn** → **Item**. Lifecycle: initialize connection → `thread/start` \| `thread/resume` \| `thread/fork` → `turn/start` (optional `turn/steer`) → stream `item/*` → finish via model completion **or** `turn/interrupt` → `turn/completed`.

`turn/steer` is different from interrupt: it **appends** user input to the **active** turn without creating a new turn. Interrupt ends that turn; steer does not.

## What is restored on continue

### Same live thread after interrupt (no process exit)

1. Turn ends `interrupted`; thread remains loaded if still subscribed.
2. User (or client) calls `turn/start` again with new input on the same `threadId`.
3. Model context is the thread’s **model-visible history** (prior turns + items already persisted for that thread), not a frozen mid-token stream.
4. By default (`agents.interrupt_message = true`), Codex **records a model-visible message** that the agent turn was interrupted, so the next turn can see that fact. Setting it `false` omits that message from agent context.
5. Goals (when enabled): interruptions **pause** the objective; resuming the thread can restore the objective when appropriate (Goals cookbook / product docs). That is goal state on the thread, not turn revival.

### After unload or new process (`thread/resume` / CLI resume)

- `thread/resume` **reopens an existing thread by id** so later `turn/start` calls **append** to it. Same thread id (not a new conversation).
- Resume alone does **not** update `thread.updatedAt` / rollout mtime; a subsequent turn does.
- Dynamic tools from start are **restored from rollout metadata** on resume if the client does not supply new ones.
- Required MCP servers that fail init cause resume to **fail** (not silent degrade).
- Model mismatch vs rollout: warning + one-time model-switch instruction on the next turn.
- `SessionStart` hook `source` can be `resume` (also `startup`, `clear`, `compact`) — resume is a first-class session-start path, distinct from compact/clear.
- Non-interactive: `codex exec resume --last` or `codex exec resume <SESSION_ID>` continues a previous exec run with an optional follow-up prompt.

### What “reload full transcript” vs “summary only” means

- **Storage:** each thread has a **persisted JSONL rollout** (sessions directory; archive moves the log; delete removes rollout + descendants). `thread/read` / `thread/turns/list` can load full turn history **without** resuming. Hooks expose `transcript_path` (format not a stable public API).
- **Model context on continue/resume:** history is rehydrated from that stored thread state into the model-visible prompt. Injected items (`thread/inject_items`) are “persisted to the rollout and **included in subsequent model requests**.”
- **Compaction is separate:** `thread/compact/start` (and auto-compact token thresholds) produce a `contextCompaction` item and shrink context so long chats stay under the window. SessionStart `source: compact` is for compaction-driven restarts, not for interrupt. Interrupt does **not** replace history with a summary; it stops the turn and keeps the thread. Over long threads, **some** history may already have been compacted earlier—that is compaction policy, not interrupt semantics.
- **Fork** copies stored history into a **new** thread id (`lastTurnId` optional). Mid-turn fork without `lastTurnId` records an **interruption marker** rather than an unmarked partial turn. Fork is branch-by-copy, not interrupt.

**Bottom line:** resume continues the **same thread object** with stored history (full items as retained after any prior compaction), not “dispose session and re-seed a one-shot summary” as the interrupt path. Compaction can mean the model later sees a compressed prefix of old work; that is orthogonal to cancel.

## Multi-agent notes

Codex multi-agent (default `agents.enabled` / `features.multi_agent`) uses collaboration tools including `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`. Subagents are **separate threads** (openable via `/agent`; listed under parent/ancestor filters; archived/deleted with the parent when those APIs cascade).

**Hosted Responses multi-agent** (API guide) is explicit:

| Action | Interrupt semantics |
| --- | --- |
| `interrupt_agent` | Interrupt another agent’s **active turn without deleting its context**. |
| `followup_task` | Assign more work to an existing non-root agent and **start or resume its turn**. |
| `close_agent` / product “close” | Ends/removes agent thread lifecycle (distinct from interrupt). |

So at the **model-orchestrated** layer: interrupt of a child = cancel that child’s **turn**, keep the agent/context addressable for later follow-up.

**User `turn/interrupt` on the parent** cancels the parent’s in-flight turn. Official docs do **not** equate that with “pause entire collaborator tree and resume later.” Subagents have their own threads and rollouts; product docs allow steering, stopping, or closing subagent threads. `agents.interrupt_message` applies when an **agent turn** is interrupted (model-visible marker).

Caveats (product/GitHub observations, not protocol guarantees): after process-level resume of the root, reattaching multi-agent V2 subagents has reported gaps; orphaned interrupted subagents appear in issues. Design intent of `interrupt_agent` is context retention; operator-level parent interrupt + process resume is not documented as a perfect tree pause/resume.

## Contrast with “dispose session and re-seed summary only”

| Behavior | Codex after interrupt | “Dispose + summary only” alternative |
| --- | --- | --- |
| Thread/session id | Kept | New id |
| Prior turns/items | Remain on rollout; next turn appends | Discarded except extracted summary |
| Interrupt marker | Model-visible interrupt message (default) | Usually not a full transcript |
| Continue mechanism | Same thread `turn/start` or `thread/resume` + turn | New session seeded with summary text |
| Compaction | Optional later shrink of long history | Always summary-only by design |
| Teardown APIs | Separate: unsubscribe unload, archive, delete, SessionEnd | Same as “done” |

Codex’s interrupt path matches **turn cancel + durable thread**. Dispose-and-summary is closer to **new chat** or aggressive compaction/clear (`SessionStart` sources `clear` / `compact`), not `turn/interrupt`.

## Sources

- [Codex App Server](https://developers.openai.com/codex/app-server) — primitives; lifecycle; `turn/interrupt` / `turn/completed` (`interrupted`); `thread/resume` append; JSONL rollout; unload grace; inject_items into model-visible history; fork interruption marker.
- [Configuration Reference](https://developers.openai.com/codex/config-reference) — `agents.interrupt_message`; multi-agent tools; `history.persistence`; compaction-related model keys.
- [Hooks](https://developers.openai.com/codex/hooks) — `SessionStart` sources `startup` \| `resume` \| `clear` \| `compact`; `SessionEnd` on archive/delete/idle close (not on interrupt alone); `transcript_path`.
- [Non-interactive mode](https://developers.openai.com/codex/non-interactive-mode) — `codex exec resume`.
- [Subagents](https://developers.openai.com/codex/subagents) — agent threads; steer/stop/close.
- [Responses multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent) — `interrupt_agent` without deleting context; `followup_task` resume.
- [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) — interruptions pause objective; thread resume can restore.
- [Advanced Config / history](https://developers.openai.com/codex/config-advanced) — `history.jsonl` under `CODEX_HOME`.
- Related internal notes: `docs/wayfinder/research-pi-codex-user-interrupt-continue.md`, `docs/wayfinder/research-pi-codex-subagent-interrupt.md`.
