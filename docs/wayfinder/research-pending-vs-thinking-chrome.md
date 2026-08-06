# Research: pending chrome vs thinking cards (expert label + continuous wait)

**Status:** research only (no product change)  
**Date:** 2026-08-07  
**Question:** Why (1) pending chrome omits expert name, and (2) continuous multi-turn work skips pending and jumps straight to ThinkingCard with content?  
**Primary sources:** Spec #276 (`docs/specs/stream-message-identity.md`), frontend stream identity module, ConversationPage, MessageRenderer / cards, related wayfinder note on ThinkingCard status.

---

## Executive summary

| Suspected bug | Verdict | Root cause (one line) |
| --- | --- | --- |
| **1. Pending does not show expert name** | **Confirmed product gap / incomplete chrome** — not Spec-#276-required omission, but current code never attaches speaker chrome | List-tail pending is rendered **outside** `MessageRenderer` with only `{ text: pendingChrome.label }`; `PendingChrome` has no expert fields; label defaults to `"思考中…"`. |
| **2. Continuous thinking skips pending** | **Mostly intentional (Spec #276)** — not a regression of the state machine | Pending is a **narrow post-send window only**; first progressive frame with body fires `stream_started` → clear; **no reseed** on tool gaps or between thinking stream sequences. |

**Recommended direction:** Fix bug 1 with a minimal chrome attribution wrapper (frontend-only). Do **not** reseed pending between tool/thinking turns unless product explicitly revises Spec #276; prefer planned **ThinkingCard lifecycle chrome** (`docs/wayfinder/research-thinking-message-status.md` Phase 2) for “still thinking” during live streams.

---

## Spec #276 baseline (authority)

Living spec: [`docs/specs/stream-message-identity.md`](../specs/stream-message-identity.md) (implemented Spec #276).

Relevant product decisions:

| Decision | Text / effect |
| --- | --- |
| Pending is **chrome**, not a Message | No `live-slot-*` / no RQ `agent_pending` dual identity |
| **Narrow chrome window** | Show “思考中…” at list tail after successful send while no progressive stream yet |
| Hide triggers | First thinking/text with `stream_id`, or task complete/error/user stop |
| Tools | **Do not** re-seed pending on tool gaps; tool feedback = tool_call cards only |
| Frozen grilling #2 | “Pending A — narrow chrome window only” |
| Frozen grilling #9 | “Chrome UI A — list-tail non-Message row (may reuse AgentPendingCard visuals)” |

Spec does **not** require expert-name on pending chrome; it also does **not** forbid it. Expert attribution on chrome is an open presentation detail.

---

## 1. Bug 1 — Pending does not show expert name

### Confirmed facts (root cause path)

#### 1.1 Agent speaker label only exists inside `MessageRenderer`

Symbol: `agentDisplayName` + `showAgentLabel` in  
`platform/frontend/src/components/MessageRenderer.tsx`

```26:50:platform/frontend/src/components/MessageRenderer.tsx
function agentDisplayName(content: Record<string, unknown>, agentNameById: Record<string, string>, ...): string {
  // Product expert persona wins — never show physical Node name as the speaker.
  const expertDisplay = String(content.expert_display_name || content.expertDisplayName || "").trim();
  // ... expert_name, expert_id → agentNameById, agent_source fallbacks ...
}
```

```733:778:platform/frontend/src/components/MessageRenderer.tsx
  const agentLabel = agentDisplayName(content, agentNameById, ...);
  const previousAgentLabel = previousMessage?.role === "agent" ? agentDisplayName(...) : "";
  const showAgentLabel = previousAgentLabel !== agentLabel;
  // ...
  return (
    <div className="my-2 min-w-0">
      {showAgentLabel && (
        <div className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
          <span className="font-medium text-ink-secondary">{agentLabel}</span>
        </div>
      )}
      {body}
    </div>
  );
```

- Label sources: `content.expert_display_name` → `content.expert_name` → `expert_id` map → `agent_source` fallbacks (`通用助理` / `平台Agent` / `渗透Agent`).
- Label is suppressed when the previous **agent** row has the same resolved name (collapse consecutive same-speaker rows).

#### 1.2 List-tail pending bypasses that wrapper

`ConversationPage` renders pending **after** the message list, not as a `Message`:

```2453:2458:platform/frontend/src/pages/ConversationPage.tsx
              {/* Spec #276: pending is chrome only — not a Message / live-slot row. */}
              {showPendingChrome && pendingChrome && (
                <div key="pending-chrome" data-testid="pending-chrome">
                  <AgentPendingCard content={{ text: pendingChrome.label }} />
                </div>
              )}
```

Consequences:

- No call to `agentDisplayName` / no `showAgentLabel` row above pending.
- Content prop is **only** `{ text: pendingChrome.label }` — never `expert_name` / `expert_display_name` / `agent_source`.
- Even the legacy `msg_type === "agent_pending"` branch **inside** `MessageRenderer` (which *would* get a label) is not used for live chrome: Spec #276 filters `agent_pending` out of display merge and does not write new RQ pending rows.

#### 1.3 Pending state machine carries label only

`platform/frontend/src/lib/messageStreamIdentity.ts`

```37:72:platform/frontend/src/lib/messageStreamIdentity.ts
export type PendingChrome = {
  conversationId: string;
  label: string;
} | null;

const DEFAULT_PENDING_LABEL = "思考中…";

export function reducePendingChrome(current, event): PendingChrome {
  switch (event.type) {
    case "send_success": {
      // label = event.label || DEFAULT_PENDING_LABEL
      return { conversationId, label };
    }
    case "stream_started":
    case "terminal":
    case "clear":
      return null;
    case "tool_output":
      return current; // neither clear nor reseed
  }
}
```

`PendingChrome` has **no** expert/speaker fields. Tests assert default label `"思考中…"` only (`messageStreamIdentity.test.ts` S2).

#### 1.4 Send path knows expert name but does not pass it into chrome

On successful send, `launchTaskMessage` already resolves `routeExpertName` / `routeExpertId` and stamps them on the **user** message and agent payload:

```1860:1918:platform/frontend/src/pages/ConversationPage.tsx
    const routeExpertName =
      resolvedMention?.kind === "expert"
        ? String(resolvedMention.name || resolvedMention.label || "").trim()
        : "";
    // ... userContent.expert_name / agentPayload.expert_name when present ...
    setPendingChrome(
      reducePendingChrome(null, {
        type: "send_success",
        conversationId: convId!,
      }),
    );
```

No `label` override, no expert fields on chrome. Default chrome text is always `"思考中…"`.

#### 1.5 Why the name appears when generation “starts”

When the first progressive frame arrives, `upsertStreamedAgentText`:

1. Builds attribution via `agentAttribution(raw)` (top-level + content `expert_name` / `expert_display_name` / `agent_source` / ids).
2. Merges into live frame content and RQ message content.
3. Clears pending via `stream_started`.

```1397:1432:platform/frontend/src/pages/ConversationPage.tsx
  function upsertStreamedAgentText(msg, msgType: "text" | "thinking") {
    // ... requires stream_id + non-empty body ...
    const attribution = agentAttribution(raw);
    const message = makeMessage(convId, "agent", msgType, { ...attribution, ...c });
    setPendingChrome((cur) => reducePendingChrome(cur, { type: "stream_started" }));
    setLiveStreams((prev) =>
      upsertLiveByStreamId(prev, {
        // ...
        content: { ...attribution, ...c },
      }),
    );
    // ...
  }
```

```3659:3671:platform/frontend/src/pages/ConversationPage.tsx
function agentAttribution(msg, fallbackSource = "pentest") {
  // agent_source, agent_node_id, expert_id, expert_name, expert_display_name
}
```

Platform WS also sticky-stamps expert onto room messages when missing (`platform/backend/app/ws/router.py` sticky expert_name paths). So the first durable/live **Message** row has speaker fields → `MessageRenderer` shows the expert header; pending never did.

### Bug 1 classification

| Aspect | Classification |
| --- | --- |
| Missing speaker chrome on list-tail pending | **Product gap / incomplete UX** — code path never wires it |
| Spec #276 “chrome not Message” | **By design** — does not force label omission |
| DEFAULT label `"思考中…"` only | **By design of state machine API** — extensible via optional `label`, but no speaker field |
| Expert name on first thinking/text Message | **Working as designed** via `agentAttribution` + `showAgentLabel` |

**Root cause path (bug 1):**  
`send_success` → `PendingChrome { conversationId, label: "思考中…" }` only → list-tail `<AgentPendingCard content={{ text }}>` with **no** MessageRenderer speaker row and **no** expert fields → first `upsertStreamedAgentText` clears chrome and inserts Message with attribution → user finally sees expert name.

---

## 2. Bug 2 — During continuous thinking, pending does not show

### Confirmed facts (root cause path)

#### 2.1 Pending is post-send only; hide on first non-empty progressive body

Lifecycle (pure S2 + ConversationPage wiring):

| Event | Source | Effect on pending |
| --- | --- | --- |
| `send_success` | After optimistic user row on send | **Show** chrome for that `conversationId` |
| `stream_started` | `upsertStreamedAgentText` (thinking/text with `stream_id` **and** body) | **Clear** |
| `tool_output` | tool WS handler | **No-op** (keep current; never reseed) |
| `terminal` | `clearProgressiveStreamUi` (task_complete/error/interrupt settle) | **Clear** |
| `clear` | conversation load/switch | **Clear** |

Critical gates in `upsertStreamedAgentText` / `upsertLiveByStreamId`:

- Missing `stream_id` → fail-closed, **no** live upsert, **no** `stream_started` (pending can stay).
- Empty body → return early; **no** pending clear, **no** live frame.

So pending is “waiting for first progressive content frame,” not “waiting for agent work in general.”

#### 2.2 Spec forbids reseed on tool gaps (and code enforces it)

Spec:

> **Do not** re-seed pending on tool gaps.  
> Tool feedback: tool_call cards only (remove tool_output → pending reseed).

Code comment + handler:

```776:777:platform/frontend/src/pages/ConversationPage.tsx
      // Spec #276: tools use tool_call cards only — never reseed pending chrome or live-slot.
      setPendingChrome((cur) => reducePendingChrome(cur, { type: "tool_output" }));
```

`reducePendingChrome` for `tool_output` returns `current` — if pending was already cleared by an earlier thinking stream, it **stays null**.

#### 2.3 Multi-turn thinking uses new `stream_id`s; no chrome reseed between them

Node4 progressive channel (`ProgressiveContentStream` in `node4/src/runtime/platform-observability.ts`):

- `startStream()` → `n4-{channel}-{taskId}-{sequence}` (sequence increments).
- `finalFlush` → flush + `reset()` (clears `streamId` / text for next turn).
- Next assistant thinking turn starts a **new** stream_id.

Frontend:

- List keys: `messageListKey` → `stream:${streamId}` so turns do not share one DOM node (Spec #276 goal).
- Each new stream with body: `upsertLiveByStreamId` + RQ mirror → **ThinkingCard with content**.
- No code path calls `send_success` (or any reseed) between turns of the same user message / task.

Timeline after one user send:

```
user send → pending chrome ON
  → first thinking frame (body) → pending OFF permanently for this send
  → ThinkingCard stream 1 (content growing)
  → tools (tool_call cards; pending stays OFF — by design)
  → LLM wait gap → still no pending
  → ThinkingCard stream 2 appears with content when first tokens arrive
  → ...
  → task_complete / interrupt → terminal clear live + pending
```

#### 2.4 Why user “expects” pending between turns

User mental model: any wait without new text should show the same “思考中…” chrome as post-send.

Product model (Spec #276 grilling): **narrow chrome window only** after send until first progressive stream. Continuous work is represented by progressive Messages (thinking/text/tools), not by re-entering chrome.

So the “skip” is **not a broken state machine** — it is the frozen design. The remaining UX hole is: **there is no alternative wait indicator** between streams / during tool→LLM gaps except:

- last ThinkingCard still on screen (often looks finished; no running/done status yet),
- tool cards,
- composer / sidebar running indicators (out of message list).

### Bug 2 classification

| Aspect | Classification |
| --- | --- |
| Pending hidden on first thinking/text with body | **Intentional** Spec #276 |
| No reseed after tools | **Intentional** Spec #276 (tools A / pending A) |
| No reseed between thinking stream sequences | **Intentional** (no event defined to reseed mid-task) |
| Jump straight to ThinkingCard with content | **Intentional** — live list requires non-empty body; empty thinking never lands |
| Lack of wait chrome mid-task | **UX gap under intentional policy** — not a lifecycle regression; address via ThinkingCard status or a **deliberate** Spec change |

**Root cause path (bug 2):**  
`send_success` seeds chrome → first `upsertStreamedAgentText` issues `stream_started` → chrome null → multi-turn Node streams only emit thinking/text with content → frontend only appends/upserts live Messages → **no second `send_success`** until next user send → user never sees pending again mid-task.

---

## 3. Interaction with planned ThinkingCard status work

Source: [`docs/wayfinder/research-thinking-message-status.md`](research-thinking-message-status.md).

| Planned work | Relation to pending bugs |
| --- | --- |
| **Phase 2** — infer running while `stream_id ∈ liveStreams`, done when only durable | Fills **mid-stream** “still thinking” on the ThinkingCard itself (pulse / 「思考中…」). Does **not** restore list-tail pending between streams or after tools. Explicitly **out of scope**: changing Spec #276 pending semantics. |
| **Phase 3** — protocol `content.status` on thinking | Same UX as Phase 2 for live/history correctness; still not pending chrome. |
| Pending chrome Spec #276 | Orthogonal identity/chrome layer; ThinkingCard status is **message card** lifecycle, pending is **pre-first-stream** chrome. |

Implications:

1. **Bug 1** is **not** solved by ThinkingCard status work. Pending still needs its own speaker chrome (or product accepts no name until first Message).
2. **Bug 2’s wait-gap UX** is **partially** addressed by Phase 2 **while a thinking stream is live**. Gaps **between** streams (after final flush / during tools / before next tokens) still have no ThinkingCard “running” and no pending — unless product reopens Spec #276 or invents a different wait indicator.
3. Do not conflate: pending label `"思考中…"` vs ThinkingCard category label `"思考"` vs future status copy `"思考中… / 已完成"`. They are three different UI surfaces.

---

## 4. Recommended fix options (minimal; do not implement here)

### Bug 1 — expert name on pending (recommended)

**Option A (minimal, preferred): wrap list-tail chrome with the same speaker row as agent messages**

- On `send_success`, extend chrome state with optional attribution already known at send time:
  - `expert_name` / `expert_display_name` / `expert_id` / `agent_source` from `routeExpertName`, `routeExpertId`, engagement (`default` → 通用助理 path).
- In `ConversationPage` pending render, either:
  - reuse a tiny shared `AgentSpeakerLabel` extracted from `MessageRenderer`, or
  - render the same markup as `showAgentLabel` above `AgentPendingCard`,
  - pass attribution into card only if needed.
- Compare against last **display** agent message’s label to avoid double-name when history already ends with same expert (mirror `showAgentLabel` rule using `displayMessages` tail).
- Keep pending **non-Message** (Spec #276 intact).

**Option B: only change `label` string** (e.g. `"渗透大师 · 思考中…"`)

- Smaller type change but mixes speaker into tool-shell title path (`AgentPendingCard` splits “思考” vs label text) and diverges from Message list speaker language. Weaker.

**Option C: reintroduce `agent_pending` Message rows**

- **Reject** — reopens Spec #276 dual identity debt.

**Tests (if implementing A):** pure pending type optional fields; ConversationPage-level or component test that pending chrome has `data-testid` speaker / expert text when send carries expert; still no RQ `agent_pending`.

### Bug 2 — wait chrome during continuous work

**Option A (preferred under current Spec): do not reseed pending; ship ThinkingCard status Phase 2**

- Live thinking streams show running chrome on the card.
- Document that post-send pending is intentionally one-shot.
- Accept tool/inter-stream gaps as no list-tail pending (composer/sidebar running remains).

**Option B: deliberate Spec #276 revision — “wait chrome mid-task”**

- New events, e.g. reseed on:
  - tool_execution_end / last tool_call done while task still working, and/or
  - conversation_working still true with no progressive live keys, and/or
  - Node “turn start” signal (would need wire work).
- Must update: `reducePendingChrome`, tests S2, Spec #276 frozen decisions #2/#5, ConversationPage handlers.
- Risk: flicker between tool cards and pending; reintroduces “gap chrome” that Spec #276 removed for a reason.

**Option C: empty ThinkingCard placeholder on stream start without body**

- Would require Node to emit stream_id **before** first tokens (today first flush requires text) **or** frontend inventing a live key without body (conflicts with fail-closed / empty-body guards).
- Larger protocol/UI change; not minimal.

**Recommendation:** treat bug 2 as **by-design** unless product explicitly wants mid-task pending; pair bug 1 fix with ThinkingCard Phase 2 for continuous-run feedback.

---

## 5. Symbol / file index

| Symbol / seam | Path |
| --- | --- |
| Spec #276 | `docs/specs/stream-message-identity.md` |
| `PendingChrome`, `reducePendingChrome`, `pendingChromeVisible`, `DEFAULT_PENDING_LABEL` | `platform/frontend/src/lib/messageStreamIdentity.ts` |
| S2 pending tests | `platform/frontend/src/lib/messageStreamIdentity.test.ts` |
| `pendingChrome` state, list-tail render, `upsertStreamedAgentText`, send `send_success` | `platform/frontend/src/pages/ConversationPage.tsx` |
| `agentAttribution` | `ConversationPage.tsx` (bottom helpers) |
| `AgentPendingCard`, `agentDisplayName`, `showAgentLabel`, `ThinkingCard` branch | `platform/frontend/src/components/MessageRenderer.tsx` |
| `ThinkingCard` | `platform/frontend/src/components/cards/ThinkingCard.tsx` |
| Progressive stream_id sequence / flush / reset | `node4/src/runtime/platform-observability.ts` (`ProgressiveContentStream`) |
| Sticky expert on WS messages | `platform/backend/app/ws/router.py` |
| ThinkingCard status plan | `docs/wayfinder/research-thinking-message-status.md` |

---

## 6. Out of scope (this note)

- Implementing chrome attribution or Spec #276 changes  
- Changing Node stream emission or platform persist  
- Composer / sidebar running lights (related UX but different surface)  
- Soft/legacy Node candidates  
