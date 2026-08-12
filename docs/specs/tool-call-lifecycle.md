# Tool call lifecycle — running card from tool-name known (Main)

**Status:** implemented — GitHub [#350](https://github.com/zangjiaao/my-ai-pen/issues/350)  
**Scope:** Node4 product tool progressive emit (`attachProductToolEventBridge`) + existing Main `ToolCallCard` projection  
**Related:** Spec [#305](timeline-activity-liveness.md) (execute-time 执行中 + thinking status); Spec [#276](stream-message-identity.md) (pending never reseeds on tools); Spec [#308](worker-process-audit.md) (package Main isolation); Spec [#353](llm-stream-liveness.md) (stream health when **no** tool name yet)

## Problem

Operators saw long tool work (especially delivery-report creation) as a frozen timeline or a hidden “background” path. The Agent used normal product tools, but **tool cards only became trustworthy process chrome at `tool_execution_start`**. For tools with large arguments, the model can spend a long time with **tool name known while args still stream**—with no Main-timeline tool card.

This is a **lifecycle projection gap**, not a separate background Agent subsystem.

## Contract (what ships)

| Anchor | Behavior |
|--------|----------|
| **Start (D1)** | As soon as Runtime knows **tool name + tool call id** for an invocation (`message_update` / `toolcall_*` on the assistant partial), emit progressive `tool_output` with `status: "running"` for that `tool_run_id`. |
| **Execute** | `tool_execution_start` emits running **only if** name-known did not already project that id; at most one progressive `running` per `tool_run_id`. Segment/salvage tool counters still bump only here. |
| **End** | `tool_execution_end` → `done` or `error` on the **same** `tool_run_id`. Product tools put `isError` on `result.details`; `afterToolCall` promotes it to pi `event.isError` (AgentToolResult has no top-level isError). |
| **Identity** | One progressive card per invocation (`tool_run_id`). No composite multi-tool group card. |
| **SoT** | Runtime owns frames; frontend **projects** only (no timer / free-text invent running). |
| **Pre-name gaps** | Covered by Thinking progressive chrome when present — not by pending reseed (#276) or N-second placeholders. |
| **Package workers** | Spec #308: no unscoped Main `tool_output`; Worker audit channel may receive the same early-running frames when scoped. |
| **Args** | Full argument bodies need not stream into open chat; status visibility is enough. |

## Implementation map

- **Runtime:** `node4/src/runtime/run-node4-agent.ts` — `namedToolInvocationsFromPartial` + `attachProductToolEventBridge` (name-known → running).
- **Frontend:** existing `tool_output` → `tool_call` path + `toolActivitySummaryLabel` / `mergeToolLifecycleStatus` (Spec #305 R2 — empty status not invented as running).
- **Tests:** `run-node4-agent.test.ts` (primary); `platform/frontend/src/lib/status.test.ts` (thin projection smoke).

## Accepted residual

- **Interrupt / abort settle (Case e8a62c56):** if the turn aborts after name-known running but before `tool_execution_end`, pi often never emits end. Product path:
  1. **Node** `attachProductToolEventBridge` wraps `session.abort` / `dispose` and emits `tool_output` `status: "error"` + `summary: "interrupted"` for every open run id.
  2. **Platform** `_settle_inflight_execution_chrome` on `task_complete` / `task_error` / idle `work_status` / idle interrupt patches durable `tool_call` (and orphan `thinking`) rows still at `status=running` (including nested `tool_items` + progressive `* running` summaries), then rebroadcasts full `tool_items` so live FE upserts without reload.
  3. **Merge** prefers fail over done over running (`_merge_tool_lifecycle_status` / FE `mergeToolLifecycleStatus` **and** per-`tool_run_id` `tool_items` merge) so a late progressive frame cannot replace items and re-light 「执行中」 under a canceled card.
  4. **FE projection safety net:** when Case is idle, explicit orphan `running` projects to fail/`canceled` (summary 「失败」, not success-family 「已执行」); progressive chip text `shell running` is scrubbed. Spec #325 B1 also withholds 耗时 on a turn while any tool_call in that segment is still running — so duration does not sit above a stuck mid-interrupt shell card.
  Without this, the next user turn sets `sessionActive` again and both the old tool pulse light and Working chrome light up.

## Out of scope (still)

Report content architecture, timer “still working” chrome, pending reseed on tool gaps, ProcessCard unification with Thinking, Dialog Markdown GFM (#327), background-Agent product concept.
