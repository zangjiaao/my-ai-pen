# Research: explicit status on thinking/reasoning messages

**Status:** research only (no product change)  
**Question:** Can the product support explicit lifecycle status on LLM thinking frames (`running` / `done`) so ThinkingCard can show 「思考中… / 已完成」?  
**Primary sources:** repo code + living docs only.

---

## Executive answers

| Question | Answer |
| --- | --- |
| **(a) Already have status?** | **No.** Thinking/reasoning frames carry body + `stream_id` only. No `status` / lifecycle field on the wire, in DB content, or in ThinkingCard. |
| **(b) Option 3 without protocol change?** | **No.** An *explicit* `content.status` field requires Node4 to set it and platform to merge/persist it (same pattern as `tool_call`). Frontend-only can only **infer** lifecycle, not author protocol status. |
| **(c) Recommended path 2 → 3** | **Phase 2 (frontend inference)** for immediate UX: treat live overlay as running, durable/history as done. **Phase 3 (protocol)** when correctness matters: Node4 `finalFlush` stamps `status: "done"`, progressive flushes stamp `status: "running"`, platform merge + ThinkingCard read `normalizeExecutionStatus` like tools. |

---

## 1. msg_types and content shape

### Wire / Node types

| Type | Role |
| --- | --- |
| `thinking` | Canonical Node4 progressive thinking channel |
| `agent_thinking` | Alias accepted by platform WS + frontend |
| `reasoning` | Alias accepted by platform WS + frontend |

Node4 progressive stream emits **`type: "thinking"`** only (not the aliases):

```178:192:node4/src/runtime/platform-observability.ts
    const type = this.channel === "thinking" ? "thinking" : "text";
    const content =
      this.channel === "thinking"
        ? { text, reasoning: text, stream_id: streamId }
        : { text, stream_id: streamId };
    // ...
        this.platform.send({
          type,
          conversation_id: this.task.conversationId,
          task_id: this.task.taskId,
          content,
          stream_id: streamId,
        } as PlatformMessage),
```

`stream_id` shape: `n4-{channel}-{taskId}-{sequence}` (e.g. `n4-thinking-{taskId}-1`) via `ProgressiveContentStream.startStream` in the same file.

Thinking body is extracted from Pi assistant content blocks with `type === "thinking"`:

```75:87:node4/src/runtime/platform-observability.ts
export function assistantThinking(message: unknown): string {
  // ...
  return content
    .filter((item: { type?: string }) => item?.type === "thinking")
    .map((item: { thinking?: string; text?: string }) =>
      String(item.thinking || item.text || ""),
    )
    // ...
}
```

### Platform normalize (persist)

On save, aliases collapse to **`msg_type = "thinking"`**; body mirrored into both `text` and `reasoning`:

```1898:1909:platform/backend/app/ws/router.py
        elif msg_type in ("thinking", "agent_thinking", "reasoning"):
            msg_type = "thinking"
            inner = msg.get("content", {})
            if isinstance(inner, dict):
                content = dict(inner)
                body = str(inner.get("reasoning") or inner.get("text") or "")
                content["text"] = body
                content["reasoning"] = body
            else:
                content = {"text": str(inner), "reasoning": str(inner)}
            if msg.get("stream_id") and not content.get("stream_id"):
                content["stream_id"] = msg.get("stream_id")
```

Stable `message_id` (uuid5) for progressive thinking:

```1837:1838:platform/backend/app/ws/router.py
    elif msg.get("type") in {"thinking", "agent_thinking", "reasoning"} and stream_id:
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"thinking:{conv_id}:{stream_id}"))
```

Dedupe key: `thinking:{stream_id}` (`_message_dedupe_key` in same file).

### Frontend handlers

```1386:1412:platform/frontend/src/pages/ConversationPage.tsx
    thinking: (msg) => {
      upsertStreamedAgentText(msg, "thinking");
    },
    agent_thinking: (msg) => {
      upsertStreamedAgentText(msg, "thinking");
    },
    reasoning: (msg) => {
      upsertStreamedAgentText(msg, "thinking");
    },
  // ...
    const body = readString(c.text) || readString(c.reasoning) || readString(raw.text);
    // ...
    if (msgType === "thinking") c.reasoning = body;
```

Render switch maps all three to `ThinkingCard`:

```755:758:platform/frontend/src/components/MessageRenderer.tsx
    case "thinking":
    case "reasoning":
    case "agent_thinking":
      body = <ThinkingCard content={content} />;
```

**Canonical content shape today (thinking):**

```json
{
  "text": "<cumulative body>",
  "reasoning": "<same body>",
  "stream_id": "n4-thinking-<taskId>-<seq>",
  "message_id": "<uuid5 thinking:conv:stream_id>",
  "agent_source"?: "...",
  "agent_node_id"?: "..."
}
```

No `status` field.

**Design doc** (`docs/design.md`) still describes ThinkingCard as `reasoning` + collapse only — no status prop:

```930:930:docs/design.md
<ThinkingCard reasoning:string, collapsed:bool, onToggle:()=>void />
```

(Contrast: ToolCallCard design already has `status:'running'|'done'|'error'`.)

---

## 2. Does thinking already carry status?

**No.**

| Layer | Status on thinking? | Evidence |
| --- | --- | --- |
| Node4 emit | No | Content is `{ text, reasoning, stream_id }` only (`platform-observability.ts` flush) |
| Platform merge | No special status path | `_merge_saved_message_content` for non-`tool_call` only length-merges text/reasoning |
| Platform save | No | Thinking branch sets text/reasoning/stream_id only |
| Frontend live frame | No | `LiveStreamFrame` has `streamId`, `msgType`, `text`, optional `messageId` / `content` — no status (`messageStreamIdentity.ts`) |
| ThinkingCard | No | Reads `reasoning \|\| text \|\| summary` only; hardcodes label 「思考」 (`ThinkingCard.tsx`) |
| `normalizeMessage` | Status only for `tool_call` | `if (msgType === "tool_call") content.status = normalizeExecutionStatus(...)` |

Pending chrome 「思考中…」 is **not** a thinking message status — it is non-Message chrome until the first progressive stream (`docs/specs/stream-message-identity.md`, `reducePendingChrome`).

---

## 3. How tool_call status works (comparison)

### Node emit

`attachProductToolEventBridge` in `node4/src/runtime/run-node4-agent.ts`:

| Pi event | Wire | `status` |
| --- | --- | --- |
| `tool_execution_start` | `type: "tool_output"` | `"running"` |
| `tool_execution_end` | `type: "tool_output"` | `"done"` or `"error"` (from `isError`) |

```296:335:node4/src/runtime/run-node4-agent.ts
      await runtime.platform.send({
        type: "tool_output",
        // ...
        status: "running",
        // ...
      });
      // ...
      await runtime.platform.send({
        type: "tool_output",
        // ...
        status: isError ? "error" : "done",
        // ...
      });
```

### Platform persist

`tool_output` → stored `msg_type: "tool_call"` with `content.status` default `"running"`; merge prefers incoming status:

```1910:1917:platform/backend/app/ws/router.py
        elif msg_type == "tool_output":
            msg_type = "tool_call"
            content = {
                # ...
                "status": msg.get("status", "running"),
```

```1801:1809:platform/backend/app/ws/router.py
    return {
        # ...
        "status": incoming.get("status") or existing.get("status") or "running",
        "tool_items": _merge_tool_items(existing, incoming),
    }
```

### Frontend normalize + UI

```1:8:platform/frontend/src/lib/status.ts
export type UiExecutionStatus = "running" | "done" | "fail";

export function normalizeExecutionStatus(value: unknown): UiExecutionStatus {
  const status = String(value || "").trim().toLowerCase();
  if (["done", "ok", "success", "completed", "complete", "saved", "loaded"].includes(status)) return "done";
  if (["fail", "failed", "error", "blocked", "canceled", "cancelled"].includes(status)) return "fail";
  return "running";
}
```

- Applied on load for `tool_call` (`normalizeMessage` in `ConversationPage.tsx`).
- Applied on merge of progressive tool records (`mergeMessageRecords`).
- `ToolCallCard` / `ToolItemRow` use status for summary text and status-dot color (`MessageRenderer.tsx`).

**Pattern to copy for thinking option 3:** explicit start/end statuses on the wire → JSONB content → normalize → card chrome.

---

## 4. Where Node4 / platform emit thinking frames

### Node4 (source of progressive thinking)

Shared free + Hard Graph path:

1. `createBoundNode4Session` / session subscribe  
2. `attachNode4SessionObservability` → `handleNode4SessionEvent` → `textStream.handle(event)`  
   (`node4/src/runtime/platform-observability.ts`)

| Pi session event | Thinking behavior |
| --- | --- |
| `message_start` (assistant) | `thinking.ensureStream()` + snapshot + maybeFlush |
| `message_update` + `assistantMessageEvent.type` starts with `thinking_` | ensure + snapshot + maybeFlush |
| `message_update` unknown kind | try both text + thinking channels |
| `message_end` (assistant) | `thinking.finalFlush(message)` then **reset** stream state |

Flush coalescing: first token immediate; later ~40ms / ≥24 chars (`TEXT_STREAM_FLUSH_MS` / `TEXT_STREAM_MIN_CHARS`). Source of truth is **cumulative full snapshot**, not raw `+=` deltas (`applySnapshot`).

`PlatformWSClient` treats `"thinking"` as a reliable outbound type (`node4/src/platform/ws-client.ts` `RELIABLE_TYPES`).

### Platform

Fast-path stream types (broadcast first, async DB):

```953:953:platform/backend/app/ws/router.py
    stream_fast = msg_type in {"text", "tool_output", "thinking", "agent_thinking", "reasoning"}
```

Flow: stamp `message_id`/`stream_id` → broadcast → `asyncio.create_task(_save_message)`.

Frontend: WS handlers above → `upsertLiveByStreamId` + RQ message upsert by stream_id.

Spec identity model: `docs/specs/stream-message-identity.md` (Spec #276) — live overlay keyed by `stream_id` only; no live-slot Message.

---

## 5. Stream end / terminal event for thinking?

**No dedicated terminal wire event.**

On assistant `message_end`:

```145:149:node4/src/runtime/platform-observability.ts
  async finalFlush(message?: unknown): Promise<void> {
    if (message !== undefined) this.applySnapshot(message);
    this.ensureStream();
    await this.flush();
    this.reset();
  }
```

`flush()` always sends the **same** message shape as intermediate frames (`type: "thinking"`, cumulative `text`/`reasoning`/`stream_id`). There is **no**:

- `thinking_end` / `thinking_done` type  
- `status: "done"` / `complete: true`  
- empty sentinel frame  

If `text === lastSentText`, final flush is a no-op (no extra frame). Terminality is only implied by:

1. Last cumulative body for that `stream_id`  
2. Local Node stream reset (new seq → new stream_id on next turn)  
3. Later conversation-level terminals (`task_complete` / `task_error` / interrupt) which **clear live overlay** but do not patch thinking rows with status  

Platform merge for thinking keeps the **longer** body so out-of-order partials cannot regress:

```1786:1799:platform/backend/app/ws/router.py
        # Streaming text/thinking: always keep the longer body so partial frames
        # cannot regress a fuller snapshot that arrived out of order.
        if msg_type in {"text", "thinking"}:
            # ... len(prev) vs len(nxt) ...
```

---

## 6. Persistence

| Aspect | Behavior |
| --- | --- |
| Stored? | **Yes** — thinking is in `stream_fast` + `should_save` path → `_save_message` |
| Table | `messages` (`platform/backend/app/models/message.py`): `role`, `msg_type`, `content` JSONB, … |
| Stored type | Always `thinking` (aliases collapsed) |
| Content fields | `text`, `reasoning` (mirrored), `stream_id`, `message_id`, optional agent attribution; **no status** |
| Dedupe / upsert | By `thinking:{stream_id}` — progressive frames update one row |
| Snapshot compact | `conversation_snapshot.compact_message_content` for text/thinking keeps `text` + agent fields only (not `reasoning` / `stream_id` / status) — snapshot is not the primary chat history path |

Reload path: REST messages pages → `normalizeMessage` → list. Live streams cleared on conversation load (`loadConversation` → `clearLiveStreams()`).

---

## 7. Gaps for option 3 (explicit status field)

Define **option 3** as: `content.status` on thinking messages, analogous to tool_call (`running` | `done` | fail-family), UI label 「思考中… / 已完成」 via ThinkingCard.

### Frontend-only inference (not option 3)

Possible **without** protocol change (call this **option 2**):

| Signal | Infer |
| --- | --- |
| Frame present in `liveStreams[streamId]` | running |
| Pruned from live (`pruneLiveCatchUp` / task terminal / load clear) + durable RQ row | done |
| History-only message after reload | assume done |
| Conversation still `running` but thinking stream not in live and no newer activity | ambiguous |

Limits of option 2:

- No persisted truth if tab closed mid-stream (DB has partial body, no “still running”).  
- Multi-turn thinking: each `stream_id` is independent; live membership is the only soft running flag.  
- No fail state for thinking (tools have error; thinking has none today).  
- Does **not** put `status` on the protocol or in JSONB.

### What option 3 actually needs

| Layer | Change |
| --- | --- |
| **Node4** | On progressive `flush`, set `content.status = "running"` (or omit and default). On `finalFlush` path, set `content.status = "done"` before reset. Optionally on dispose / abort, emit one done frame if stream had text. |
| **Platform** | Thinking merge: prefer terminal status over running (`incoming done` wins, like tools). Persist `status` in content. Optionally stamp uuid5 message_id unchanged. |
| **Frontend live** | Carry status on `LiveStreamFrame` / content through `upsertLiveByStreamId`. |
| **ThinkingCard** | Read `normalizeExecutionStatus(content.status)`; labels 「思考中…」 / 「已完成」 (and optional status-dot language matching tools). |
| **History** | Durable rows with `status: "done"` after final frame; mid-crash partials may remain `"running"` unless a settle path rewrites them. |
| **Docs** | `docs/design.md` ThinkingCard props; Spec #276 note if status becomes identity-adjacent. |

**Option 3 cannot be done correctly without Node (or platform synthetic stamp on some terminal) protocol change.** Platform cannot invent “done” at save time without knowing whether a frame is final — all frames look the same today.

Minimal protocol delta (recommended):

```ts
// progressive
{ type: "thinking", content: { text, reasoning, stream_id, status: "running" } }
// finalFlush last frame
{ type: "thinking", content: { text, reasoning, stream_id, status: "done" } }
```

Reuse `normalizeExecutionStatus` vocabulary; no new enum required.

---

## 8. Historical messages on reload — can UI know complete without status?

| Scenario | Can UI know complete? |
| --- | --- |
| Normal completed turn, messages reloaded | **Only by convention:** anything in durable history is treated as finished. Live map is empty after load. Partial-but-saved text looks “complete.” |
| Mid-stream disconnect, partial saved | **No** — row has longest body so far, no lifecycle bit. Option 2 would show as done on reload. |
| Live session, stream still in `liveStreams` | Soft “running” without status field |
| After `task_complete` / interrupt | Live cleared; thinking rows remain without status — UI must assume done |

**Conclusion:** Without a persisted status (or a terminal flag), reload **cannot** distinguish complete vs truncated thinking. For product copy 「已完成」 on history cards, defaulting all durable thinking to done is the only honest frontend-only approach (and matches how tools without status already default via normalize → running, while tool history usually has explicit done).

Note: tool history without status would normalize to **running** (`normalizeExecutionStatus("")` → `"running"`). Thinking has no such field, so ThinkingCard never shows running/done chrome today.

---

## Recommended path: 2 → 3

### Phase 2 — frontend inference (no protocol)

Scope: `ThinkingCard` + live/durable merge in `ConversationPage` / `messageStreamIdentity`.

1. While `stream_id ∈ liveStreams` → show 「思考中…」 (pulse / `status-running`).  
2. When live pruned or only RQ → show 「已完成」 (or static 「思考」 + done chrome).  
3. On conversation load / terminal clear → all thinking cards done.  
4. Do **not** write fake `status` into RQ as if Node sent it (avoids lying in persisted content).

Accept: reload + crash partials always look complete; no fail state.

### Phase 3 — explicit status (protocol option 3)

When UX needs reload-correct lifecycle or parity with tool cards:

1. **Node4** `ProgressiveContentStream.flush`: include `status: "running"`; `finalFlush` last send uses `status: "done"`.  
2. **Platform** `_merge_saved_message_content` for thinking: merge status like tool_call (terminal wins).  
3. **Frontend** pass through + `ThinkingCard` + optional `normalizeMessage` for `thinking`.  
4. Optional settle: on task_complete, patch any `status: "running"` thinking rows to `done` (platform-only safety net).  
5. Tests: Node progressive final frame status; platform merge; ThinkingCard labels; reload fixture with `status: "done"`.

### Why not jump only to 3?

Phase 2 is Spec-#276-aligned (frontend-only), unblocks 「思考中… / 已完成」 quickly, and validates card chrome. Phase 3 is small and mirrors tools but touches Node + platform + persist contracts — do when inference bugs (reload mid-flight, multi-tab) matter.

---

## Key symbols index

| Symbol | Path |
| --- | --- |
| `assistantThinking` / `PlatformTextStream` / `ProgressiveContentStream` | `node4/src/runtime/platform-observability.ts` |
| `attachProductToolEventBridge` | `node4/src/runtime/run-node4-agent.ts` |
| `attachNode4SessionObservability` / `handleNode4SessionEvent` | `node4/src/runtime/platform-observability.ts` |
| `_save_message` / `_merge_saved_message_content` / `_stamp_stream_message_ids` | `platform/backend/app/ws/router.py` |
| `Message` model | `platform/backend/app/models/message.py` |
| `normalizeExecutionStatus` | `platform/frontend/src/lib/status.ts` |
| `upsertLiveByStreamId` / `pruneLiveCatchUp` / `mergeMessagesWithLiveStreams` | `platform/frontend/src/lib/messageStreamIdentity.ts` |
| `upsertStreamedAgentText` / WS handlers | `platform/frontend/src/pages/ConversationPage.tsx` |
| `ThinkingCard` | `platform/frontend/src/components/cards/ThinkingCard.tsx` |
| `ToolCallCard` status UI | `platform/frontend/src/components/MessageRenderer.tsx` |
| Stream identity Spec #276 | `docs/specs/stream-message-identity.md` |
| Design ThinkingCard | `docs/design.md` |

---

## Out of scope (this note)

- Implementing Phase 2 or 3  
- Changing pending chrome Spec #276 semantics  
- Pi internal `thinking_*` event taxonomy beyond Node’s `startsWith("thinking_")` filter  
- Reasoning **token** usage fields (`reasoning_tokens` in llm_usage) — unrelated to ThinkingCard lifecycle  
