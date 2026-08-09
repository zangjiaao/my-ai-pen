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
| **End** | `tool_execution_end` → `done` or `error` on the **same** `tool_run_id`. |
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

- If the model turn aborts after name-known running but before `tool_execution_end`, the tool card may remain `running` until session/turn failure surfaces via existing fail paths (adjacent Spec #353 stream health / `LlmTurnError`). Emitting synthetic error frames for open run ids on abort is a follow-up, not required for D1.

## Out of scope (still)

Report content architecture, timer “still working” chrome, pending reseed on tool gaps, ProcessCard unification with Thinking, Dialog Markdown GFM (#327), background-Agent product concept.
