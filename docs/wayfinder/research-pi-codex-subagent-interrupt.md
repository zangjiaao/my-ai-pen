# Research: Pi + Codex interrupt while subagents run

Facts only. Scope: interrupt / cancel while child or parallel workers are active, and continue/re-dispatch after. Sources: local `research/pi` and public OpenAI Codex / Responses multi-agent docs (2026). Related single-session interrupt note: `docs/wayfinder/research-pi-codex-user-interrupt-continue.md`.

## Executive answer

| | Pi | Codex |
| --- | --- | --- |
| First-class subagents | No (core is one agent + tools; subagents are an **example extension**) | Yes (default multi-agent / subagent threads) |
| User interrupt while children run | Parent turn abort → shared `AbortSignal` → in-flight tools/subagent **processes killed** | Parent `turn/interrupt` **aborts progress** (not a pause of the tree); model may also call `interrupt_agent` |
| Child context after interrupt | Killed process work not resumable; parent transcript kept | `interrupt_agent` keeps agent context; user interrupt / process resume have gaps (orphans, reattach bugs) |
| Parent after interrupt | Idle; new prompt / re-dispatch tools; no automatic revive of killed children | Same thread; parent can steer/stop/close; `followup_task` can resume a non-root agent turn |
| Selective keep some children | Not built-in; one signal kills all workers that honor it | Designed per-agent interrupt + follow-up; product pause-of-tree is requested, not shipped as non-destructive |

Neither system resumes a mid-token provider stream. Continue = new turn(s) on preserved history / agent tree state.

## Pi

### Core: tools, not a session tree

- Product kernel path is a single `Agent` run. Parallelism is **parallel tool calls** (`toolExecution: "parallel"` default), not a first-class agent tree (`packages/agent` README / CHANGELOG).
- Each run creates an `AbortController`. `Agent.abort()` / `Agent.signal` expose it (`packages/agent/src/agent.ts` — `abort()`, `signal`, `runWithLifecycle`).
- Stream + tool path: `signal` is passed into provider stream, `beforeToolCall` / `afterToolCall`, and `tool.execute(..., signal, onUpdate)` (`agent-loop.ts`).
- On assistant `stopReason` `error` | `aborted`, the loop ends immediately (no further tool batches) (`agent-loop.ts` ~196–199).
- Aborted tool prep returns error tool result `"Operation aborted"` (~591–611). Sequential execution **breaks** starting further tools after abort (~440–442). Parallel mode still **awaits already-started** tool promises (`Promise.all` ~502–504); further preflight stops when abort is seen (~478–499).
- Tools that ignore `AbortSignal` can keep running until they finish; cancellation is cooperative except where implementers kill processes.
- After abort: run finishes idle (`finishRun`); transcript keeps partial/aborted assistant (+ any tool results already emitted). `Agent.continue()` only works if last message is user/toolResult or queues have items—after a clean abort last is usually **assistant/aborted**, so product path is a **new user prompt**, not bare `continue()` (`agent.ts` ~337–365). AI docs: push aborted partial + “Please continue” (`packages/ai/README.md` Continuing After Abort).
- Durable harness: unfinished turn/provider → mark interrupted; unfinished tool → interrupted/error result unless retry-safe; **provider streams not resumable** (`packages/agent/docs/durable-harness.md` ~134–142).
- Session **fork** is transcript-tree branching (`SessionRepo.fork`), not cancel/isolate of child agents.

### Subagents: example extension only

- Documented as optional extension / SDK use case (“custom tools that spawn sub-agents”), not core product (`coding-agent/docs/sdk.md`, `examples/extensions/subagent/`).
- Implementation: tool `subagent` spawns a **separate `pi` process** per task (`--mode json -p --no-session`), modes single / parallel (max 8 tasks, concurrency 4) / chain (`examples/extensions/subagent/index.ts`, README).
- **Abort propagation:** same parent `signal` is passed to every `runSingleAgent`. On abort: `proc.kill("SIGTERM")`, then `SIGKILL` after 5s if still alive (~399–408). Aborted run throws `"Subagent was aborted"`; result treated as failed (`stopReason` aborted / non-zero exit).
- Parallel: **one shared signal → all in-flight child processes killed**. No “keep finished workers, cancel only running” control plane beyond what already finished before abort.
- Chain: on failed/aborted step, chain **stops** and returns partial `results` (~566–573); later steps never start.
- Parent after abort: tool call fails/errors into parent transcript; parent agent returns idle. Parent may **re-dispatch** new `subagent` tool calls on a later turn. **No resume of the killed child process** or its private context (children used `--no-session`).
- Key symbols/paths: `Agent.abort`, `Agent.signal`, `runLoop` / `executeToolCallsParallel`, `AgentSession.abort`, extension `runSingleAgent` + `signal.addEventListener("abort", killProc)`.

## Codex

### First-class multi-agent

Codex (ChatGPT Work / CLI / IDE) runs **subagent workflows by default** (`agents.enabled` default true). Built-ins: `default`, `worker`, `explorer`; custom agents via `~/.codex/agents/` or `.codex/agents/` TOML. Docs: [Subagents](https://developers.openai.com/codex/subagents), [Responses Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent).

Hosted collaboration actions (model-callable `multi_agent_call`; app does not execute them):

| Action | Role re: interrupt / continue |
| --- | --- |
| `spawn_agent` | Create child + initial task |
| `send_message` | Queue message without starting a turn |
| `followup_task` | More work on existing non-root agent; **start or resume** its turn |
| `wait_agent` | Wait for mailbox update |
| `interrupt_agent` | **Interrupt another agent’s active turn without deleting its context** |
| `list_agents` | Tree, statuses, `last_task_message` |

Root is `/root`; children use hierarchical paths (e.g. `/root/reviewer/tester`). `max_concurrent_subagents` (API default 3) caps concurrent active subagent turns across the tree.

User/product controls (docs): open subagent thread; ask to **steer, stop, or close** completed threads. Config: `agents.interrupt_message` (default true) records a **model-visible** interruption message; `agents.max_concurrent_threads_per_session`.

App-server user cancel: `turn/interrupt` ends the in-flight turn with interrupted status (see prior interrupt research / app-server docs). That is **turn abort of progress**, not a documented “pause entire collaborator tree and resume later” primitive. Feature request: non-destructive pause/resume for multi-agent thread trees ([openai/codex#34809](https://github.com/openai/codex/issues/34809)) states `turn/interrupt` is **not** equivalent to pausing collaborators.

### After interrupt: resume vs re-dispatch

- **By design (API):** `interrupt_agent` preserves agent context; `followup_task` can resume a non-root agent’s turn; parent synthesizes results. Interrupted children are intended to stay addressable in the tree, not deleted.
- **User steer/stop/close:** docs instruct natural-language control of running/completed threads; not a guarantee of partial-tool resume mid-stream.
- **Observed gaps (GitHub, product bugs—not normative docs):**
  - Interrupted subagents can become **orphaned** / missing status; `close_agent` may not clean them ([#19197](https://github.com/openai/codex/issues/19197)).
  - After **resume root session in a new process**, Multi-agent V2 may fail to resume existing subagents ([#33002](https://github.com/openai/codex/issues/33002)); subagent list / `/agent` issues after `/resume` ([#19140](https://github.com/openai/codex/issues/19140)).
  - Parent wait on subagent completion can break on disconnect/reconnect or collab interrupt, needing a **manual parent prompt** to continue ([#16386](https://github.com/openai/codex/issues/16386), [#9607](https://github.com/openai/codex/issues/9607)).
- `resume_agent` appears in multi-agent feature/config discussion; the public Responses multi-agent table names **`followup_task`** as the resume/start-turn action for existing non-root agents.

## Comparison

| Dimension | Pi | Codex |
| --- | --- | --- |
| Child model | Optional tool → OS process | First-class agent thread tree |
| Cancel mechanism | One `AbortSignal` per parent run | User `turn/interrupt` + model `interrupt_agent` |
| Kill vs soft stop | Extension hard-kills child `pi` (SIGTERM/KILL) | Interrupt turn; context kept for `interrupt_agent` |
| Parallel workers on parent Esc | All signal-honoring workers cancel/killed | Tree interrupt/stop semantics; not non-destructive pause |
| Resume killed/interrupted child | Re-spawn tool with new task; no process resume | `followup_task` / re-open thread when tree state intact |
| Parent re-plan after interrupt | Yes (new prompt on same session) | Yes (new turn; may need manual nudge if wait broke) |

## Implications for Main-controlled package continue/cancel after interrupt

1. **Cancel while package workers run should be turn-scoped AbortSignal** (Pi model), not task deletion: parent stays; in-flight workers must observe cancel.
2. **If children are OS processes or separate sessions**, Pi’s example is the honest pattern: **kill on abort, re-dispatch on continue**—do not claim mid-process resume without durable child sessions.
3. **If children are first-class threads with preserved context** (Codex multi-agent), separate **interrupt** (stop turn, keep context) from **close** (dispose) and support **follow-up / re-dispatch** without respawning from zero.
4. **Selective keep:** neither product gives a clean “user Esc keeps finished children, cancels only running ones, auto-continues parent with partial results” as a single primitive—partial results only if already finalized before abort. Product Main continue/cancel should define explicitly: (a) cancel all workers, (b) cancel running keep completed, (c) soft-interrupt resumable children—and implement deliberately.
5. **Continue after interrupt ≠ resume stream:** re-plan from transcript + known worker outcomes; optional model-visible interrupt marker (Codex-style) helps the parent reorient.
6. **Do not equate parent interrupt with package-fail gates**; treat abort as cooperative cancel (aligned with prior Pi/Codex interrupt research).

## Sources

**Pi (local)**  
- `research/pi/packages/agent/src/agent.ts` — `abort`, `signal`, `continue`, `runWithLifecycle`  
- `research/pi/packages/agent/src/agent-loop.ts` — abort checks, parallel/sequential tools  
- `research/pi/packages/agent/docs/durable-harness.md` — mark interrupted / no stream resume  
- `research/pi/packages/ai/README.md` — Aborting / Continuing After Abort  
- `research/pi/packages/coding-agent/src/core/agent-session.ts` — `AgentSession.abort`  
- `research/pi/packages/coding-agent/examples/extensions/subagent/` — process spawn, SIGTERM/KILL, parallel/chain  
- `research/pi/packages/coding-agent/docs/sdk.md` — sub-agent as custom-tool pattern  

**Codex / OpenAI (web)**  
- https://developers.openai.com/api/docs/guides/responses-multi-agent — `interrupt_agent`, `followup_task`, tree  
- https://developers.openai.com/codex/subagents (and learn.chatgpt.com agent-configuration/subagents) — manage/steer/stop/close; `agents.interrupt_message`  
- GitHub openai/codex issues #34809, #33002, #19197, #19140, #16386, #9607 — interrupt vs pause, resume/orphan gaps  
- Prior: `docs/wayfinder/research-pi-codex-user-interrupt-continue.md`  
