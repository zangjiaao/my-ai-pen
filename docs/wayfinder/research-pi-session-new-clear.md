# Research: pi / oh-my-pi Session `/new` vs product Reset/Delete

**Date:** 2026-08-08  
**Trigger:** Spec #354 collab Session Delete/Reset semantics; operator expected pi-agent-core instance lifecycle, not expert-catalog id renames.

## Primary sources

| Source | Location |
|--------|----------|
| pi coding-agent slash table | https://pi.dev/docs/latest/usage — `/new` = "Start a new session" |
| pi `/new` handler | `research/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts` → `text === "/new"` → `handleClearCommand()` |
| pi `handleClearCommand` | same file → `runtimeHost.newSession()` |
| pi `AgentSessionRuntime.newSession` | `research/pi/packages/coding-agent/src/core/agent-session-runtime.ts` |
| pi `SessionManager.newSession` | `research/pi/packages/coding-agent/src/core/session-manager.ts` — mints **new session id** + empty transcript |
| pi-agent-core `Agent` | `node4/node_modules/@earendil-works/pi-agent-core` — `reset()` clears messages/queues; `sessionId` on Agent |
| oh-my-pi | docs: `/fresh` resets **provider stream** without local transcript change (different from `/new`); advisor uses `agent.reset()` |

## What `/new` does (pi coding-agent)

1. Interactive `/new` calls `handleClearCommand()` (not a separate command name "clear" in latest docs; implementation reuses clear naming).
2. `runtimeHost.newSession()`:
   - emits before-switch hooks
   - builds a **new** `SessionManager` (persisted or in-memory)
   - **`teardownCurrent("new", …)`** — dispose previous runtime/session resources
   - **`createRuntime(…)`** — new Agent runtime bound to the new SessionManager
   - `session_start` reason `"new"`
3. `SessionManager.newSession()` assigns **`this.sessionId = options?.id ?? createSessionId()`** and resets leaf/file entries — operator-visible session id **changes**.

So product analogy:

| Operator action | pi analogue | pi-agent-core action |
|-----------------|-------------|----------------------|
| **Reset** | `/new` (keep workspace; new session id + empty model memory) | **Dispose** current `Agent` (abort + `reset()` + clear queues), **construct a new `Agent`** with a **new `sessionId`**, keep product Todo/work list |
| **Delete** | leave / drop session (no reattach) | **Dispose** `Agent`, **drop park**, remove collab participant; incomplete Todo → pending handoff hold |

## What product must not do

- Treat **expert catalog UUID** (`269b0fae-…` 平台助理) as the only Session id and hide the copy button when it is the fallback.
- Auto-merge PRs that change collab chrome without explicit operator ask.
- Claim Reset is complete if it only re-parks a shell without minting a new pi `Agent.sessionId` on reseed.

## Node4 mapping (post-fix intent)

- `wrapAgentAsSession.dispose` → `abort` + `Agent.reset()` + `clearAllQueues` (instance teardown).
- `createBoundNode4Session` / `runNode4Agent` always bind a concrete `sessionId` (mint if omitted).
- `resetWorkingSessionMemory` → dispose parked Agent, mint **new** `agentSessionId`, re-park Todo shell with `needsAgentReseed`; next attach `createBoundNode4Session({ sessionId })` builds a **new** Agent.
- Session Delete → dispose + drop park + remove participant (unchanged Spec L10).

## Collab copy chrome

Show copy control **only** when a real pi-agent-core `Agent.sessionId` is projected
(Node checkpoint / Reset ack → participant `session_instance_id` → FE `session_id`).

- Never fall back to expert catalog id (`expert:{uuid}`) — that is product identity, not the Agent instance.
- Hide the button until the Agent is constructed (or Reset mints a new id).
