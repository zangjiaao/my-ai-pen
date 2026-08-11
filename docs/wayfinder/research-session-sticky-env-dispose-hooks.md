# Research: Session sticky pen-sandbox — where dispose hooks already exist

**Date:** 2026-08-11  
**Ticket:** wayfinder #420  
**Scope:** Read-only map of platform WS/API + Node4 handlers for Session dispose, park terminalization, Case close, interrupt, and task-end cleanup.  
**Destination (map #418):** Session-sticky pen-sandbox (browser + shell), dispose on **Session delete / park terminalization / Case close + idle** — **not** on work-burst / task end. Supersedes Spec #320 task-end dispose model for sticky env.  
**Does not implement product code.**

**Related living docs:**  
- Spec #354 — `docs/specs/session-owns-runtime.md` (Session owns captain runtime; Task = package)  
- Spec #320 / #333 — `docs/specs/pen-tools-sandbox.md` (browser sandbox = **one container per parent task**, dispose on task end)  
- Prior research (partially **stale** vs post-#354 code) — `docs/wayfinder/research-session-idle-reclaim.md`

---

## 0. Vocabulary (do not collapse)

| Term | What it is **today** | Lifecycle bus? |
|------|----------------------|----------------|
| **Case** | Platform `conversation_id` | Delete API → Node `case_session_release` |
| **Participant Session** | `conversation_id + expert_id` (collab roster / park key) | Delete API → Node `session_dispose` |
| **Working-session park** | In-process `Map` of captain pi + Todo (`working-session-park.ts`) | Local Node authority; product dispose marks pending then force-dispose |
| **Task / work burst** | One platform→Node `task_assign` package | **Not** Session death (#354) |
| **Browser sandbox (Spec #320)** | Long-lived Docker container keyed by **`parentTaskId`** | Task-end `runTaskResourceCleanup` + lease janitor |
| **Shell pen-sandbox** | `docker run --rm` per shell command (`pen-tools-shell.ts`) | Ephemeral; no Session stickiness yet |
| **Subagent idle pool** | Warm package workers | Task-end `disposeAll` + own TTL — **not** product Session |

---

## 1. Existing lifecycle bus (do **not** invent a second one)

There is already a **structured platform→Node Session lifecycle channel** with acks (Spec #354). Sticky-env dispose should **piggyback** this bus and the Node park dispose fan-in — not add parallel WS types or a separate env-lifecycle registry.

### 1.1 Platform → Node message types

| Wire `type` | Platform emitter | Payload | Node ack |
|-------------|------------------|---------|----------|
| `case_session_release` | `_notify_node_case_session_release` | `{ conversation_id }` | `case_session_release_ack` |
| `session_dispose` | `_notify_node_session_op(..., "session_dispose")` | `{ conversation_id, expert_id? }` | `session_dispose_ack` |
| `session_reset` | `_notify_node_session_op(..., "session_reset")` | same | `session_reset_ack` |

**Sources:**

- Emit helpers: `platform/backend/app/api/conversations.py` — `_notify_node_case_session_release`, `_notify_node_session_op`, `_push_node_json`
- Ack waiters: `platform/backend/app/ws/router.py` — `register_session_lifecycle_ack_waiter`, `resolve_session_lifecycle_ack`, `await_session_lifecycle_ack`
- Node handlers: `node4/src/main.ts` — `client.on("case_session_release" | "session_dispose" | "session_reset")`

Ack key shape: `{ack_type}:{conversation_id}:{expert_id}` (`_session_lifecycle_ack_key`). Waiter is registered **before** send so fast acks are not dropped.

### 1.2 Node captain dispose authority (single fan-in)

| Symbol | File | Role |
|--------|------|------|
| `decideCaptainEndDisposition` / `decideParkOnEnd` | `node4/src/runtime/working-session-park.ts` | Policy: park vs dispose whitelist |
| `applyCaptainEndDisposition` | same | Applies park/dispose; **force-dispose** when pending Case/Session delete mid-burst |
| `markPendingSessionDispose` / `markPendingCaseDispose` | same | Mid-burst dispose flags |
| `isPendingDispose` | same | Finally consults pending sets |
| `disposeWorkingSession` | same | Session delete: drop park + `entry.dispose()` + open_todos |
| `disposeWorkingSessionsForCase` | same | Case close: all parks under Case |
| `dropParkedSession` / `takeParkedSession` / replace in `parkWorkingSession` | same | Park terminalization / replace / TTL drop |
| `resetWorkingSessionMemory` | same | Reset: dispose Agent, re-park Todo shell (`needsAgentReseed`) |

**Dispose whitelist (code today):** `case_close` | `session_delete` | `manual_end` | `expert_transfer`  
(`CaptainDisposeReason` in `working-session-park.ts`)

**Package settle / interrupt never dispose captain:** `decideParkOnEnd({ aborted })` → park only; `productTerminal` alone is ignored (#354). Covered by `working-session-park.test.ts`.

---

## 2. Trigger map: emit → Node hears → recommended sticky-env call site

### 2.1 Session delete (manual collab Delete)

| Step | Where | Symbol / path |
|------|-------|----------------|
| UI | FE RightPanel collab | `runSessionLifecycle("delete")` → `POST /api/conversations/{id}/sessions/delete` (`platform/frontend/src/components/RightPanel.tsx`) |
| API | Platform | `delete_participant_session` (`conversations.py`) |
| Platform → Node | WS push | `_notify_node_session_op(node, "session_dispose", conversation_id, expert_id)` |
| Node handler | `main.ts` | `client.on("session_dispose")`: `markPendingSessionDispose` (or Case-wide if no expert), abort live burst, `waitConversationIdle`, `disposeWorkingSession` |
| Captain tear | park module | `disposeWorkingSession` → `entry.dispose()` (today: **pi only**) |
| Mid-burst | Free/Graph/parked finally | `applyCaptainEndDisposition` sees `isPendingDispose` → force dispose reason `session_delete` / `case_close` |
| Platform after ack | API | pending handoff todos, `remove_participant`, `settle_context_after_session_delete`, status → `incomplete`, broadcast `conversation_working` reason `session_delete` |

**Recommended sticky-env attach:**

1. **Primary:** extend `ParkedWorkingRuntime.dispose` (and the dispose lambdas at Free/Graph finally) to also tear Session-keyed pen-sandbox, **or**  
2. **Central fan-in:** call env dispose inside `disposeWorkingSession` / force-dispose branch of `applyCaptainEndDisposition` so both idle-park and mid-burst paths hit one place.

Do **not** add a second platform message type for env.

### 2.2 Case close (conversation delete)

| Step | Where | Symbol / path |
|------|-------|----------------|
| API | Platform | `delete_conversation` (`conversations.py`) — **before** DB delete |
| Platform → Node | WS | `_notify_node_case_session_release` → `{ type: "case_session_release", conversation_id }` |
| Node handler | `main.ts` | `markPendingCaseDispose` → abort → idle wait → `disposeWorkingSessionsForCase` → `case_session_release_ack` |
| Captain tear | park | all keys `conv` or `conv::*` |

**Recommended sticky-env attach:** same as Session delete, Case-scoped: dispose **all** Session env under `conversation_id` from `disposeWorkingSessionsForCase` (and pending force-dispose on live finally).

**Gap vs Spec L1 wording (“delete/**archive**”):**

- Product statuses are `created|running|paused|completed|incomplete|failed|canceled` only (`conversation_state.py` `CONVERSATION_STATUSES`) — **no `archived` status**.
- Audit vocab lists `conversation.archive` (`platform/backend/app/api/audit.py`) but **no API path** was found that archives a Case and notifies Node.
- **Today, only hard Case delete** fires `case_session_release`. If product later adds archive-without-delete, it must reuse the **same** message, not a new bus.

### 2.3 Park terminalization (Node-local; no new WS)

“Park terminalization” = park entry **dropped with dispose**, not “package settled into park.”

| Path | Function | Disposes captain? | Sticky-env should dispose? |
|------|----------|-------------------|----------------------------|
| Explicit Session/Case dispose | `disposeWorkingSession` / `ForCase` | Yes | **Yes** (primary) |
| Mid-burst pending force | `applyCaptainEndDisposition` + `isPendingDispose` | Yes | **Yes** |
| Same-key replace | `parkWorkingSession` prior `prev.dispose()` | Yes (old park) | **Yes** for **old** Session key only if replace means true identity replace (today same key = same Session — usually same env) |
| Lazy TTL expire | `takeParkedSession` / `resolveWorkingSessionContinue` | Yes if `ttlMs > 0` | **Yes if product idle reclaim is enabled** |
| Mode mismatch / C1 drop | `dropParkedSession` via `resolveWorkingSessionContinue` | Yes | **Yes** (Session working runtime reseed; env continuity debatable — default **dispose + reseed** for honesty) |
| Reset | `resetWorkingSessionMemory` | Dispose Agent; **re-park** Todo shell | **Policy choice:** keep sticky env (browser cookies useful) **or** dispose with Agent — product must pick; wire already exists either way |
| Package settle / interrupt | `applyCaptainEndDisposition` → **park** | No | **No** (Session continues) |

**Park TTL today:** `DEFAULT_PARK_TTL_MS = 0` → `isParkExpired` never true → **no idle park reclaim** (#354 L2). Map #418 “+ idle” is a **product policy gap**, not an existing timer on captain park. Subagent idle pool and browser **lease janitor** are different layers (see §4).

**Recommended attach for park terminalization:** wrap or extend every `entry.dispose()` invocation site, ideally **only** through:

- `applyCaptainEndDisposition` dispose branch  
- `disposeWorkingSession` / `disposeWorkingSessionsForCase`  
- `dropParkedSession`  
- `takeParkedSession` TTL branch  
- `parkWorkingSession` replace of prior entry  

Avoid scattering env dispose into Free/Graph runners beyond the dispose callback they already pass.

### 2.4 Interrupt (must **not** dispose sticky env)

| Step | Where | Behavior |
|------|-------|----------|
| Platform UI | WS `user_interrupt` fan-out | `_interrupt_all_session_workers` (`ws/router.py`) |
| Node | `client.on("user_interrupt")` (`main.ts`) | `abort.abort()`; status_update only |
| Free/Graph finally | `decideParkOnEnd({ aborted: true })` | **park** captain |
| Browser sandbox today | `cleanupTaskResources` in same finally | **Still disposes** sandbox on task end (#320) — **conflicts** with sticky-env goal |

**Implication for #418:** moving browser/shell to Session-sticky requires **removing or gating** task-end sandbox dispose in `runTaskResourceCleanup` / Free+Hard finally, while leaving interrupt→park captain behavior unchanged.

### 2.5 Task end / work-burst cleanup (current #320 model — **not** Session death)

| Resource | Call site | Symbol |
|----------|-----------|--------|
| Browser sandbox | Free finally + Hard Graph finally | `cleanupTaskResources` → `runTaskResourceCleanup` → `disposeBrowserSandbox(task.taskId)` (`session-runner.ts`, `task-resource-cleanup.ts`) |
| Subagent idle pool | same | `idlePool.disposeAll()` |
| Hold/heartbeat | same | `releaseBrowserSandboxTask(task.taskId)` |
| Process shutdown | `main.ts` graceful stop | `disposeAllBrowserSandboxes()` |
| Lease orphans | background jobs | `BrowserSandboxRuntime.reapExpired` janitor |

**Shell:** not long-lived — `runShellInPenTools` uses `docker run --rm` per command (`pen-tools-shell.ts`). Sticky shell env would be **new** product behavior, not a dispose-hook relocation.

**Recommended for sticky env:**

- **Stop** disposing Session-sticky pen-sandbox from `runTaskResourceCleanup` (or key it by Session and skip dispose on package settle).  
- Keep subagent `disposeAll` on task end (package workers ≠ Session env).  
- Keep process-level `disposeAllBrowserSandboxes` for Node shutdown (ops safety net).

### 2.6 Session Reset (related; not full Session death)

| Step | Path |
|------|------|
| UI / API | `POST .../sessions/reset` → `_notify_node_session_op("session_reset")` |
| Node | `resetWorkingSessionMemory`: dispose parked Agent, mint new `agentSessionId`, re-park Todo |
| Env | **No** env dispose today |

Reset is **not** on the #418 dispose list. Prefer **not** tearing sticky browser on Reset unless product explicitly wants clean cookies; Reset already clears model memory only (Spec #354 L9).

### 2.7 Unwired / absent dispose reasons

| Reason | In policy? | Production wire? |
|--------|------------|------------------|
| `manual_end` | Yes (`CaptainDisposeReason`) | **No** dedicated API found (collab Delete uses `session_dispose` instead) |
| `expert_transfer` | Yes | **Never** passed true at Free/Graph/parked finally call sites; expert switch leaves prior park intact (#354 L3) |
| Case archive | Spec L1 text | **No** implementation |
| Product idle reclaim of park | Spec L2 says no; #418 mentions idle | `DEFAULT_PARK_TTL_MS = 0`; no background sweeper |

---

## 3. Full diagram (existing bus only)

```
FE collab Delete ──POST /sessions/delete──► delete_participant_session
                                              │
                                              ├─► session_dispose ──WS──► main.ts handler
                                              │                              ├ markPendingSessionDispose
                                              │                              ├ abort live burst (optional)
                                              │                              └ disposeWorkingSession ──► entry.dispose() [pi]
                                              │                                        ▲
                                              │                                        │ force-dispose
FE Case delete ──DELETE /{conv_id}──► delete_conversation                   finally: applyCaptainEndDisposition
                                              │                              (isPendingDispose)
                                              └─► case_session_release ──► disposeWorkingSessionsForCase

Package settle / interrupt ──► decideParkOnEnd → park (no dispose) ── sticky env should LIVE
Task finally today ──► runTaskResourceCleanup → disposeBrowserSandbox(taskId) ── #320; supersede for sticky

Park drop (TTL/mismatch/C1/replace) ──► entry.dispose() ── park terminalization attach point
```

---

## 4. What exists vs gaps for Session-sticky pen-sandbox

### Exists (safe to reuse)

1. **Platform Session lifecycle bus** with acks (`session_dispose`, `case_session_release`, `session_reset`).  
2. **Node pending-dispose + finally force-dispose** so mid-burst Delete/Case close cannot re-park.  
3. **Single captain end policy** (`decideCaptainEndDisposition` / `applyCaptainEndDisposition`) shared by Free, Hard Graph stage, parked-continue.  
4. **Park key** already matches product Session identity: `parkSessionKey(conversationId, expertId)`.  
5. **Browser runtime abstraction** (`BrowserSandboxRuntime.ensure/exec/dispose`) — only re-key + lifecycle ownership need product change.  
6. **Graceful Node shutdown** already disposes all browser sandboxes.

### Gaps / conflicts

| Gap | Detail |
|-----|--------|
| **#320 task-key + task-end dispose** | Sandbox keyed by `parentTaskId` (`containerNameForParentTask`); cleaned every burst — **directly opposes** Session-sticky destination |
| **Shell not sticky** | Ephemeral `--rm` containers; no Session-scoped shell env handle |
| **`entry.dispose` is pi-only** | Free/Graph pass `dispose: () => session.dispose()`; park dispose does **not** touch Docker env |
| **Archive** | Spec mentions Case archive; code only has Case **delete** → `case_session_release` |
| **Idle** | Captain park TTL disabled (0); browser lease janitor is task-lease based, not Session idle |
| **Stale research** | `research-session-idle-reclaim.md` still describes pre-#354 world (30m TTL, Case delete not notifying Node) — **do not trust for implementation** without re-reading code |

### Unsafe / avoid

- New WS types like `env_dispose` / `sandbox_release` when Session bus already exists.  
- Platform keyword/NLP “Session end.”  
- Disposing sticky env from `user_interrupt` or package-complete settle.  
- Coupling sticky env to subagent idle pool TTL.  
- Expanding product behavior in legacy `node/` / `node2/` / `node3/`.

---

## 5. Recommended call-site strategy (no second bus)

**Normative order for implementers of sticky-env dispose:**

1. **Key** pen-sandbox by Participant Session (`conversation_id` + `expert_id`), not `task.taskId`.  
2. **Hold/renew lease** across work bursts while Session park or live captain exists (not only while a single parent task is held).  
3. **Dispose env** only through the **existing captain dispose fan-in**:
   - `disposeWorkingSession` / `disposeWorkingSessionsForCase` (API-driven Session/Case end)  
   - `applyCaptainEndDisposition` dispose branch (incl. pending mid-burst)  
   - `dropParkedSession` / TTL / replace (park terminalization)  
   Optionally fold into `ParkedWorkingRuntime.dispose` so all of the above stay one callback.  
4. **Remove or gate** browser dispose from `runTaskResourceCleanup` for Session-sticky mode (keep subagent pool dispose).  
5. **Idle:** if product wants idle dispose, either re-enable a **Session-scoped** park TTL with dispose fan-in, or a Session-keyed sandbox lease — still call the **same** dispose function; do not invent a second bus. Default today remains “no idle Session death” (#354 L2) until product explicitly reopens L2.  
6. **Reset:** default keep env; only dispose if product later requires clean browser state.  
7. **Process death / janitor:** retain as safety net for orphaned containers (labels must become Session-keyed if task-key is retired).

---

## 6. Primary sources (files + symbols)

| Area | Path | Symbols |
|------|------|---------|
| Case delete + Session delete/reset API | `platform/backend/app/api/conversations.py` | `delete_conversation`, `delete_participant_session`, `reset_participant_session`, `_notify_node_case_session_release`, `_notify_node_session_op`, `_push_node_json` |
| Lifecycle ack bus | `platform/backend/app/ws/router.py` | `resolve_session_lifecycle_ack`, `register_session_lifecycle_ack_waiter`, `_session_lifecycle_ack_key`; reason `session_delete` on workers settle |
| Collab FE | `platform/frontend/src/components/RightPanel.tsx` | `runSessionLifecycle` |
| Node WS handlers | `node4/src/main.ts` | `case_session_release`, `session_dispose`, `session_reset`, `user_interrupt`, `task_assign` / `runAssignedTask` |
| Park + dispose policy | `node4/src/runtime/working-session-park.ts` | all symbols in §1.2; `DEFAULT_PARK_TTL_MS = 0` |
| Park tests | `node4/src/runtime/working-session-park.test.ts` | package settle parks; dispose whitelist |
| Free end | `node4/src/runtime/session-runner.ts` | `cleanupTaskResources`, `applyCaptainEndDisposition` finally |
| Graph stage end | `node4/src/runtime/hard-graph-stage-executor.ts` | `applyCaptainEndDisposition` in stage finally |
| Parked continue end | `node4/src/runtime/run-parked-working-continue.ts` | same policy; re-park |
| Task resource cleanup | `node4/src/runtime/task-resource-cleanup.ts` | `runTaskResourceCleanup` |
| Browser sandbox | `node4/src/runtime/browser-sandbox-runtime.ts`, `browser-sandbox-image.ts` | `dispose`, `holdParentTask`, `containerNameForParentTask` |
| Shell sandbox | `node4/src/runtime/pen-tools-shell.ts` | `runShellInPenTools` (`docker run --rm`) |
| Spec #354 | `docs/specs/session-owns-runtime.md` | L1–L10 dispose rules |
| Spec #320 | `docs/specs/pen-tools-sandbox.md` | task-scoped browser lifecycle |

---

## 7. Short answers to the ticket questions

1. **Where do Session delete, park terminalization, Case close already surface?**  
   - **Session delete:** REST `POST .../sessions/delete` → WS `session_dispose` → `disposeWorkingSession` + pending finally force-dispose.  
   - **Case close:** REST `DELETE .../{conv_id}` → WS `case_session_release` → `disposeWorkingSessionsForCase` + pending case dispose.  
   - **Park terminalization:** Node-local park map drops (`dispose*`, `dropParkedSession`, replace, optional TTL) — no separate platform event.  
   - **Interrupt / task end:** separate channels (`user_interrupt`, `runTaskResourceCleanup`); must **not** be Session-env dispose triggers under #418.

2. **Which hooks are safe for sticky-env dispose without a second lifecycle bus?**  
   - Attach to **existing** Spec #354 Session lifecycle messages and the **single** Node park dispose fan-in (`disposeWorkingSession*`, `applyCaptainEndDisposition` dispose, `dropParkedSession` / replace).  
   - Do **not** invent new WS types; do **not** dispose sticky env on task package settle or interrupt.

3. **What must change for #418 (out of scope for this research, noted only):**  
   - Re-key long-lived pen-sandbox off `parentTaskId` onto Session key; stop task-end dispose for that resource; wire dispose into park/Session fan-in above.

---

## 8. Explicit non-goals of this note

- No product code changes.  
- No new Spec text beyond research.  
- No recommendation to revive Soft Graph, dual Node kernels, or hardcoded intent NLP.
