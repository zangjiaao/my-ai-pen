# Stream message identity — remove live-slot-as-Message

**Status:** implemented (Spec #276)  
**Scope:** Platform frontend conversation stream UI only  
**Depends on (do not change in this Spec):** Node4 `n4-{thinking|text}-{taskId}-{seq}` stream_ids; platform uuid5 `message_id` stamp per type+stream_id  
**Follow-on:** Timeline activity liveness — thinking `status`, empty running thinking, pending speaker reuse — see [`timeline-activity-liveness.md`](timeline-activity-liveness.md) (extends progressive content shape + pending clear triggers; does **not** reseed pending on tool gaps).

## Problem

Progressive assistant thinking/text used a dual identity model:

1. Fake Message rows (`msg_type: agent_pending`, id `live-slot-{conversationId}`) for “思考中…”
2. Real streams keyed by `stream_id`

That forced morph/align/delete logic across the list, live overlay, and React Query. Pinning thinking bubbles to one live-slot React key caused multi-turn thinking to rewrite older cards. Follow-up hardening fixed keys but left the dual model as maintainability debt and regression risk.

## Solution (product)

- **Delete live-slot-as-Message.** Pending is **chrome**, not a Message.
- **Message list identity** for progressive text/thinking = **`stream_id` only**.
- **RQ** remains durable message SOT; **live overlay** is `Record<streamId, stream frame>` only (no live-slot keys).
- **Working chrome:** show **indicator light + `工作中...`** at list tail after successful send **until first agent output** (thinking/text progressive or tool_output); then hide. **Do not** invent Working from tool alone when chrome already null. Toggle off for A/B: `localStorage my-ai-pen.workingChrome=0`.
- **Thinking / tool leading:** pulse **status light while running**; **category/Brain icon when done/fail**. Cards remain stream content (Chinese labels for tools).
- **Missing `stream_id`:** fail-closed — do not enter live progressive list; do not invent fallback keys.
- **Prune live:** clear on conversation load/switch, task_complete, task_error, interrupt settle; optionally drop a live key when RQ already has same stream_id with text ≥ live.

## Seams (test here)

| Seam | Behavior |
|------|----------|
| **S1 pure identity module** | `messageListKey`; live map key = stream_id only; no live-slot helpers required after delete; merge progressive text |
| **S2 Working chrome lifecycle** | show after send; hide on first stream/tool_output/terminal; never invent from tool alone; `isWorkingChromeEnabled` gate |
| **S3 live prune** | boundary clear; catch-up prune when RQ has stream with ≥ text |
| **S4 display merge** | RQ messages (filter agent_pending) ∪ live by stream_id; list React keys by stream_id |

Prefer S1–S3 pure functions over ConversationPage integration tests.

## Out of scope

- Node/Platform stream stamping changes
- Graph/Free / C1 / Finding identity (#275)
- Full E2E browser suite
- RightPanel agent tree styling

## Frozen decisions (grilling)

1. End state A — delete live-slot-as-Message  
2. Pending A — Working chrome until first agent output (light + 工作中...); thinking/tool cards use light while running, icon when done
3. Data A — RQ SOT + live by stream_id  
4. Retire `agent_pending` Message type (filter history)  
5. Tools A — tool_call cards only  
6. No stream_id A — fail-closed  
7. Prune A — boundary + catch-up  
8. Scope A — frontend only  
9. Chrome UI A — list-tail non-Message row (may reuse AgentPendingCard visuals)  
10. Tests A — pure identity/pending/prune contracts  
