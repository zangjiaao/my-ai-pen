# Spec: Session auto-title (Agent renames default「新会话」)

**Status:** Implementable Spec (product contract) — **living**  
**Tracker:** [#457](https://github.com/zangjiaao/my-ai-pen/issues/457)  
**Decision source:** Product UX demand — new Cases default to「新会话」; operators rarely rename; long lists of identical titles. Agent should set a short title from the first **substantive** user task.

**Product path:** Platform conversation list + top bar + Node4 Agent tools (ADR 0001).  
**Not part of:** Owner ledger [#454](https://github.com/zangjiaao/my-ai-pen/issues/454); Session dialogue path [#455](https://github.com/zangjiaao/my-ai-pen/issues/455).

**Amends (thin):**  
- `docs/design.md` — 会话自动命名 (design already sketched; this Spec is the product contract).  
- `docs/prd.md` — 登录与会话 / 会话自动命名.  
- Does **not** reintroduce platform conversation Agent persona (Node seat Agent only).

**Does not amend:** Finding Store, intent NLP for engagement/mode, Task/package dialogue packaging (#455).

---

## Problem Statement

New conversations are created with the default title **「新会话」**. Operators seldom rename them. Over time the sidebar is full of identical titles, so Cases cannot be told apart.

Operators want a **short, useful title** from the first real task, written to the Case (sidebar + top bar), without forcing a manual rename — and **without occupying the Expert**. Auto-title is a **harness housekeeping** chore (thin Node Agent, not a Participant Session). The Expert only renames when the user asks.

Constraints:

- Pure greetings must **not** burn the default title.  
- User-chosen titles must **not** be overwritten silently.  
- Title changes must not spam the chat timeline.  
- Platform must **not** invent titles via keyword/NLP tables on free text (Agent judgment + explicit tool write only).

---

## Solution

1. **Default remains「新会话」** (and known English placeholders) at Case create.  
2. **Agent tool** `platform_set_conversation_title` updates **this** conversation’s title via Node-authenticated ledger API.  
3. **Auto path (housekeeping):** when the title is still a default placeholder **and** the task envelope has a **structured** target / `scope.allow`, harness kicks a **thin Node Agent** (title tool only) in parallel with the Expert. `only_if_default=true`. Silent — no chat bubble, no participant, no todo. If that turn does not land a title, harness applies a structured compose (`pack.id · host[:port]`) through the same tool.  
4. **Gate is the envelope, not greeting NLP.** No target and empty allow → treat as chat / 寒暄 → skip. Expert Free prompt no longer assigns auto-title.  
5. **Explicit rename:** user asks the Expert (or Default seat) → tool with `only_if_default=false`.  
6. **Live UI:** after success, Node emits `conversation_title_updated`; frontend patches the conversation store (sidebar + top bar) without full reload.  
7. **Wire:** `task_assign` may include `conversation_title` so housekeeping and Expert know the current placeholder.  
8. **Manual rename** in Sidebar (existing PATCH) remains; after that, auto path skips (`only_if_default`).

### Product locks

| # | Lock |
|---|------|
| **L1** | Auto-title only when current title is a **default placeholder** (`only_if_default=true` server-enforced). |
| **L2** | Placeholders include at least: `新会话`, `New session`, `Untitled`, `未命名会话`, empty/whitespace. |
| **L3** | Turns **without** structured target / `scope.allow` **must not** auto-title (寒暄 / ledger chat). |
| **L4** | Title length: short (product guidance ≤~24 Chinese chars or ~40 Latin); server max 255; non-empty. |
| **L5** | No platform free-text keyword table inventing titles. Housekeeping Agent authors (tool persist); structured compose fallback uses envelope fields only (`pack.id` + host/port). |
| **L6** | `conversation_title_updated` is **not** a chat timeline message (do not persist as agent chat row). |
| **L7** | User manual rename and explicit Agent rename always allowed when not restricted by empty title. |
| **L8** | Tool is scoped to the **current** `conversation_id` on the task (no cross-Case rename). |
| **L9** | Auto-title is **harness housekeeping** on every `task_assign` that passes L1+L3 — including Expert packs. Expert / Default keep the tool **only** for user-asked rename. |
| **L10** | Orthogonal to #454 owner ledger and #455 Task/Session dialogue packaging. |

---

## User Stories

1. As an operator, I want new Cases still start as「新会话」, so that create stays one click.  
2. As an operator, I want the first real task to produce a short sidebar title, so that I can find the Case later.  
3. As an operator, I want greetings not to rename the Case, so that「你好」does not become a title.  
4. As an operator, I want my manual rename to stick, so that Agent auto-title never overwrites it.  
5. As an operator, I want to ask the Agent to rename, so that I can fix a bad auto title in chat.  
6. As an operator, I want the top bar title to update live, so that I need not refresh.  
7. As an operator, I want the sidebar list to update live, so that multi-Case navigation stays honest.  
8. As an operator, I want no chat bubble for “I renamed the session”, so that the timeline stays about work.  
9. As an Expert Agent, I want auto-title **not** in my first-turn plan, so that todo / recon is not competing with a chore.  
10. As an Expert Agent, I want `only_if_default` on the tool, so that a user-asked rename cannot clobber a later custom title by mistake.  
11. As housekeeping, I want the same tool with `only_if_default=true`, so that Expert Cases still get titles without a second Participant Session.  
12. As a platform implementer, I want Node token auth on the title PATCH, so that only bound Nodes can write.  
13. As a platform implementer, I want audit optional/lightweight, so that title churn is not noisy (may share conversation.update patterns).  
14. As a QA engineer, I want unit tests for placeholder detection and only_if_default skip, so that L1/L2 hold.  
15. As a QA engineer, I want a fixture that auto-title does not run when title is already custom, so that L1 holds.

---

## Implementation Decisions

1. **API:** `PATCH /api/node/ledger/conversations/{id}/title` with body `{ title, only_if_default? }`; resolve owner via conversation; return `{ ok, skipped?, title, before?, conversation_id }`.  
2. **Tool:** `platform_set_conversation_title` on Node platform tools; citizen + default tool lists; on success send WS `conversation_title_updated`.  
3. **Envelope:** Platform attaches `conversation_title` when building `task_assign` (from Conversation row).  
4. **Housekeeping:** `node4/src/runtime/housekeeping.ts` — parallel thin Agent (title tool only, thinking off); hush sink (only `conversation_title_updated` reaches the platform); structured compose fallback. Not a Participant Session.  
5. **Prompts:** Expert / Default / citizen mention **user-asked rename only**. Auto-title duty is **not** on the Expert.  
6. **Frontend:** Handle `conversation_title_updated` (bypass case gate so sidebar updates); existing Sidebar manual PATCH unchanged.  
7. **Placeholders:** Shared server frozenset + Node helper for default detection.  
8. **Ship separately from #454:** own Spec, issue, and PR.

---

## Testing Decisions

- **Good tests:** only_if_default skip when title custom; empty title rejected; placeholder membership; tool registered on default seat; housekeeping gate (default+target fires; greeting without target does not; custom title skips); hush sink drops chat frames.  
- **Prior art:** `test_conversation_title_node.py`, `platform.policy.test.ts`, `node4/src/runtime/housekeeping.test.ts`.  
- **Optional e2e:** create Case → send substantive message with target → title leaves「新会话」(manual or integration).

---

## Out of Scope

- A second Participant Session / UI participant for naming.  
- Platform-side keyword/NLP title tables on free text. Structured compose fallback is envelope fields only.  
- Renaming other Cases from this tool.  
- Full history of title changes UI.  
- Owner ledger (#454) or Task dialogue packaging (#455).  
- Translating titles by node language policy (may follow user language; not a hard gate here).

---

## Further Notes

Design.md already described auto-naming; this Spec freezes Agent-tool + only_if_default as the persist path. Auto-title itself is harness housekeeping (thin Node Agent + structured compose fallback), not an Expert first-turn duty.

## Changelog

| Date | Change |
|------|--------|
| 2026-08-15 | First publish — #457. |
| 2026-08-15 | Auto-title moved to harness housekeeping; Expert keeps user-asked rename only. |
