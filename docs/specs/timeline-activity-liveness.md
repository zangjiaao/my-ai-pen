# Timeline activity liveness — thinking status, pending speaker, tool running

**Status:** implemented — GitHub [#305](https://github.com/zangjiaao/my-ai-pen/issues/305)  
**Scope:** Node4 progressive thinking frames + platform merge/persist + conversation timeline UI (ThinkingCard, pending chrome speaker, ToolCallCard status correctness)  
**Related:** Spec #276 [`stream-message-identity.md`](stream-message-identity.md); research [`../wayfinder/research-thinking-message-status.md`](../wayfinder/research-thinking-message-status.md), [`../wayfinder/research-pending-vs-thinking-chrome.md`](../wayfinder/research-pending-vs-thinking-chrome.md)

## Problem Statement

Operators watching a Case conversation cannot always tell what the Agent is doing. After send, a pending “思考中…” row appears without the expert speaker name that every real agent message already uses; the name only pops in when the first thinking/text body arrives. Mid-task, after tools finish and while the model is thinking again (or waiting on a long tool), the chat timeline often goes silent—tool rows all look “已完成,” pending never returns (by #276 design), and thinking cards only appear once tokens exist—so the UI looks stuck even though the Agent is still working.

## Solution

Keep Spec #276’s narrow pending chrome (post-send only; no tool-gap reseed). Make the **three existing timeline surfaces** faithfully project Agent activity:

1. **Pending chrome** — still only after successful send until the first progressive activity; **reuse the existing expert speaker row rules** (show on first speaker / expert switch; collapse while the same expert continues). No new display language.
2. **Thinking card** — explicit `status` on thinking messages (`running` | `done`); title is the lifecycle itself (`思考中…` / `思考完成`); full body when expanded; **default expanded** (including done); allow **empty body while `running`** so mid-task “thinking again” is visible before tokens (T1).
3. **Tool card** — while a tool is executing, the card must show **执行中**; if long-running tools incorrectly look **已完成**, fix that path in the same delivery (S+).

Users always see either pending (first wait), thinking-in-progress, tool-in-progress, or a completed state—not a frozen timeline of only finished tools.

## User Stories

1. As an operator, I want to see who is working when the post-send pending row appears, so that expert attribution is continuous with the rest of the chat.
2. As an operator, I want the expert name suppressed while the same expert keeps working, so that the timeline is not noisy.
3. As an operator, I want the expert name to reappear when the speaker changes, so that handoffs are obvious.
4. As an operator, I want pending to appear after I send a message, so that I know the system accepted the turn.
5. As an operator, I want pending to disappear when progressive thinking or text starts (including an empty running thinking frame), so that chrome does not stack with real cards.
6. As an operator, I do not want pending to reappear between tool calls, so that Spec #276’s narrow chrome stays predictable.
7. As an operator, I want a thinking card titled “思考中…” while the model is reasoning, so that silence is not ambiguous.
8. As an operator, I want a thinking card even before the first reasoning token mid-task, so that tool→think gaps do not look stuck.
9. As an operator, I want thinking body text to stream into the expanded area, so that I can read full reasoning without a truncated header preview.
10. As an operator, I want the thinking card to default to expanded (including after done), so that I can read reasoning without an extra click.
11. As an operator, I want to collapse a thinking card to a single header line, so that I can shorten a long thread.
12. As an operator, I want a completed thinking card to say “思考完成,” so that lifecycle is scannable like tool summaries.
13. As an operator, I want thinking status to come from an explicit protocol field, so that reload and multi-tab stay consistent.
14. As an operator, I want historical thinking without status treated as done, so that old messages still render sensibly.
15. As an operator, I want tool cards to show “执行中” while a tool is running, so that long shell/browser work is visible.
16. As an operator, I want tool cards to show “已完成” or a failure family only after the tool ends, so that status is trustworthy.
17. As an operator, I want false “已完成” during an active tool fixed in the same effort, so that timeline liveness is complete.
18. As a developer, I want thinking progressive frames to stamp `status: running` and final flush `status: done`, so that UI does not invent lifecycle.
19. As a developer, I want platform merge/persist to keep thinking `status` like tool_call status, so that durable messages match the wire.
20. As a developer, I want live upsert to accept empty body when status is running, so that T1 empty thinking frames enter the list.
21. As a developer, I want `stream_started` (pending clear) on progressive thinking/text activity including empty running thinking, so that pending and thinking do not double up.
22. As a developer, I want ThinkingCard to mirror ToolCallCard shell language (icon + title row + expandable body), so that the timeline stays visually consistent.
23. As a developer, I want no hardcoded fake reasoning text, so that agent engineering rules are respected.
24. As an operator on first message in a room chat without a named expert, I still want pending and later cards to use existing agent label fallbacks, so that “who is working” still has a name when the product already has one.
25. As an operator, I want right-panel phase signals and chat timeline to stop contradicting each other for “llm_waiting vs idle,” so that chat is the primary place I look.

## Implementation Decisions

### Product principles

- **Liveness over silence:** at every moment of an active turn, the timeline should project thinking, tool wait, or first-wait pending—not a wall of only completed tools.
- **Reuse speaker rules:** pending must use the same expert/agent display name resolution and same-speaker collapse as agent messages. Do not invent a second “pending expert badge.”
- **Three surfaces, clear jobs:**
  - Pending = post-send first wait only (#276 unchanged on reseed).
  - Thinking = model reasoning lifecycle (including empty running mid-task).
  - Tool = tool execution lifecycle.
- **Explicit status (option 3):** thinking lifecycle is `content.status` (and/or top-level status mirrored into content), not frontend-only inference as the long-term SOT. Ship protocol + UI in one change set.
- **Title copy (B):** header is the lifecycle string only — `思考中…` while running, `思考完成` when done. No stacked fixed “思考” + status column.
- **Default expanded:** including done; product may later switch done-default-collapsed without redesigning the card.
- **No truncated header preview** of reasoning; body holds full text when expanded; collapsed is header-only (one line).
- **S+ tools:** primary delivery is thinking status + T1 + pending speaker; if tool cards falsely show done while still executing, fix in the same delivery after a long-tool repro.

### Protocol — thinking status

- Progressive thinking frames include `status: "running"` (body may be empty after T1 start).
- Terminal thinking flush (assistant message end / final thinking flush) includes `status: "done"` and the full cumulative body when any.
- Status vocabulary aligns with existing execution status normalization used by tools (`running` | `done` | fail-family if ever needed; fail not required for v1 if Node never emits it for thinking).
- Platform save/merge for thinking must retain `status` (prefer newer terminal `done` over stale `running`; never drop `done` when a late partial arrives).
- Missing status on historical rows: treat as **done** for label purposes.

### Progressive stream identity (#276 deltas)

- Keep stream_id identity, live map, RQ SOT, no live-slot Message, no pending reseed on tools.
- **Delta:** allow live upsert of thinking frames with empty body when `status === running` (today empty body is rejected).
- **Delta:** clear pending chrome on first progressive **activity** for the turn: thinking/text with stream_id, including empty running thinking—not only non-empty body.
- First post-send wait remains pending until that activity; mid-task re-entry into thinking uses T1 thinking cards, not pending.

### T1 empty running thinking

- When the thinking channel opens for an assistant turn (or equivalent llm_waiting after tools), Node may emit a running thinking frame with empty body and stable `stream_id` before first token.
- Do not rely on pending reseed for mid-task gaps.
- First wait after user send still prefers pending + speaker; once any progressive thinking/text activity starts, pending is gone for that send window.

### ThinkingCard UI

- Default `expanded = true`.
- Header: brain (or existing) icon + lifecycle title (`思考中…` / `思考完成`).
- Body: full reasoning with existing pre-wrap/break behavior; empty running shows no fake placeholder paragraph (or only empty expanded area).
- Remove 96-char truncated preview in the header row.
- Click toggles expand/collapse; local component state only (not persisted).

### Pending speaker

- Carry send-time (or room) attribution fields already known at send into pending chrome state **or** wrap list-tail pending with the same speaker row component/path used by MessageRenderer.
- Label visibility must follow existing same-speaker collapse relative to the previous agent row in the list (if last agent message is the same expert, do not re-print the name above pending).
- Pending remains non-Message chrome (not written as RQ `agent_pending`).

### Tool card status (S+)

- Verify running→done emission and frontend merge for tool_call rows on long-running tools.
- Fix false done (premature status, merge preferring done too early, default status “done” when missing on in-flight rows, etc.) if repro’d.
- Do not reintroduce tool_output→pending reseed.

### Modules (conceptual)

- Node progressive content stream (thinking channel stamp + optional empty running start).
- Platform WS message save/merge for thinking content.
- Frontend stream identity / live upsert / pending clear rules.
- ThinkingCard presentation.
- Conversation list-tail pending rendering (speaker reuse).
- ToolCallCard / tool status merge path (S+).

### Docs

- Living contract: this file. Update `stream-message-identity.md` with a short pointer that pending clear triggers include empty running thinking and that thinking carries `status`.
- Research notes under `docs/wayfinder/` remain historical background.

## Testing Decisions

### What makes a good test

- Assert **external progressive behavior**: status on frames, pending visibility, speaker visibility rules, card title/expand defaults, tool summary “执行中” vs “已完成.”
- Prefer pure functions and small unit tests at stream-identity / status-normalize seams over full browser E2E.
- Do not snapshot raw internal class names as the only assertion; prefer testids and status strings already used by the UI.

### Seams (test here)

| Seam | Behavior |
|------|----------|
| **S1 Thinking status protocol** | Progressive thinking frames expose `running`; final flush exposes `done` + full body; empty running frame allowed with stream_id |
| **S2 Live upsert + pending clear** | Empty running thinking upserts into live map; clears pending; still fail-closed without stream_id; tools never reseed pending |
| **S3 ThinkingCard projection** | Title from status; default expanded; no header truncation; empty running renders without fake body copy |
| **S4 Pending speaker** | Same attribution + same-speaker collapse as agent messages; pending still non-Message |
| **S5 Tool running (S+)** | In-flight tool_call shows 执行中; completion shows 已完成/fail; no premature done on active run |

### Prior art

- Spec #276 pure tests in frontend stream identity module (pending reduce, live upsert, list keys).
- Node tests that assert tool_output `running` then `done` on platform messages.
- Platform merge tests for tool_call status and progressive text/thinking body length.

## Out of Scope

- Reseeding pending chrome on tool gaps or mid-task idle (would revise #276 frozen “narrow window”).
- Right-panel redesign (panel may already show llm_waiting; this spec’s primary fix is chat timeline).
- Soft scenario graph / Node5 / dual-kernel paths.
- Translating tool stdout; changing tool categorization icons.
- Persisting per-user expand/collapse preferences for thinking cards.
- Auto-collapsing done thinking after N lines (explicit follow-up if threads get long).
- Full E2E browser suite as a gate (optional manual/long-tool check for S5).

## Frozen decisions (grilling)

1. Title copy **B** — lifecycle as title (`思考中…` / `思考完成`).
2. Completion **option 3** — explicit `status` on thinking; ship protocol + UI together (not inference-only).
3. Default expand **always** (including done).
4. Mid-task liveness **T** — thinking surface owns mid-task “still working,” not pending reseed.
5. Empty running **T1** — allow empty body + `running` mid-task; post-send first wait remains pending.
6. Card first-token policy refined by T1: empty running is allowed when the thinking channel is open; not “content-only forever.”
7. Pending speaker — **reuse** MessageRenderer speaker rules; not a new badge language.
8. Delivery **S+** — thinking + pending speaker primary; tool false-done fixed in same delivery if repro’d.
9. No #276 pending reseed change.

## Further Notes

- Research background: `docs/wayfinder/research-thinking-message-status.md`, `docs/wayfinder/research-pending-vs-thinking-chrome.md`.
- Spec #276 remains authority for stream_id identity and pending non-Message chrome; this spec **extends** progressive thinking content shape and pending clear/upsert rules only as listed.
- Agent engineering rules: no hardcoded fake reasoning/security findings; derive from real stream state.
