# Spec: Session auto-title (harness names default「新会话」)

**Status:** Implementable Spec (product contract) — **living**  
**Tracker:** [#457](https://github.com/zangjiaao/my-ai-pen/issues/457); follow-up [#482](https://github.com/zangjiaao/my-ai-pen/issues/482); auto path is a harness write [#548](https://github.com/zangjiaao/my-ai-pen/issues/548)  
**Decision source:** Product UX demand — new Cases default to「新会话」; operators rarely rename; long lists of identical titles. The first **substantive** structured envelope should set a short title.

**Product path:** Platform conversation list + top bar + Node4 harness write (ADR 0001). Default still has `platform_set_conversation_title` for user-asked rename; pentest / act-expert no longer have the tool.  
**Not part of:** Owner ledger [#454](https://github.com/zangjiaao/my-ai-pen/issues/454); Session dialogue path [#455](https://github.com/zangjiaao/my-ai-pen/issues/455).

**Amends (thin):**  
- `docs/design.md` — 会话自动命名 (design already sketched; this Spec is the product contract).  
- `docs/prd.md` — 登录与会话 / 会话自动命名.  
- Does **not** reintroduce platform conversation Agent persona (Node seat Agent only).

**Does not amend:** Finding Store, intent NLP for engagement/mode, Task/package dialogue packaging (#455).

---

## Problem Statement

New conversations are created with the default title **「新会话」**. Operators seldom rename them. Over time the sidebar is full of identical titles, so Cases cannot be told apart.

Operators want a **short, useful title** from the first real task, written to the Case (sidebar + top bar), without forcing a manual rename — and **without a dedicated naming Session**. Auto-title is a **Main Task-layer** duty on the addressed Default / Expert Free turn. Graph stages and Package workers do not name the Case.

Constraints:

- Pure greetings must **not** burn the default title.  
- User-chosen titles must **not** be overwritten silently.  
- Title changes must not spam the chat timeline.  
- Platform must **not** invent titles via keyword/NLP tables on free text (structured envelope only + optional user-asked rename).

---

## Solution

1. **Default remains「新会话」** (and known English placeholders) at Case create.  
2. **Harness write** on Free Main start updates **this** conversation’s title via the same Node-authenticated ledger PATCH (`only_if_default=true`). Title text comes from `structuredTargetHint` (envelope Target / `scope.allow` only).  
3. **Auto path is not an Agent tool turn.** Task hint may say harness will name the Case; pentest / act-expert no longer expose `platform_set_conversation_title`. Default keeps the tool for **user-asked** rename. Silent — do not announce, do not add a todo. No second Agent Session.  
4. **Gate is the envelope, not greeting NLP.** No target and empty allow → treat as chat / 寒暄 → skip.  
5. **Explicit rename:** user asks the current Default Main → tool with `only_if_default=false`. Sidebar PATCH remains.  
6. **Live UI:** after success, Node emits `conversation_title_updated`; frontend patches the conversation store (sidebar + top bar) without full reload.  
7. **Wire:** `task_assign` may include `conversation_title` so the Task hint / harness gate know the current placeholder.  
8. **Manual rename** in Sidebar (existing PATCH) remains; after that, auto path skips (`only_if_default`).

### Product locks

| # | Lock |
|---|------|
| **L1** | Auto-title only when current title is a **default placeholder** (`only_if_default=true` server-enforced). |
| **L2** | Placeholders include at least: `新会话`, `New session`, `Untitled`, `未命名会话`, empty/whitespace. |
| **L3** | Pure greeting / small-talk turns **must not** auto-title. |
| **L4** | Title length: short (product guidance ≤~24 Chinese chars or ~40 Latin); server max 255; non-empty. |
| **L5** | No platform free-text keyword table inventing titles. Auto path writes from structured envelope only; Default may still rename when the user asks. |
| **L6** | `conversation_title_updated` is **not** a chat timeline message (do not persist as agent chat row). |
| **L7** | User manual rename and explicit Agent rename always allowed when not restricted by empty title. |
| **L8** | Tool is scoped to the **current** `conversation_id` on the task (no cross-Case rename). |
| **L9** | Auto-title is a **harness write** on Default / Expert Free Main start when L1+L3 hold. Graph stages and Package workers do **not** auto-title. |
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
9. As a Main Agent, I want auto-title as a harness write, so that naming does not need a tool turn or a second Session.  
10. As a Default Agent, I want `only_if_default` on the title tool, so that a user-asked rename cannot clobber a later custom title by mistake.  
11. As a Graph stage / Package worker, I do not own Case naming.  
12. As a platform implementer, I want Node token auth on the title PATCH, so that only bound Nodes can write.  
13. As a platform implementer, I want audit optional/lightweight, so that title churn is not noisy (may share conversation.update patterns).  
14. As a QA engineer, I want unit tests for placeholder detection and only_if_default skip, so that L1/L2 hold.  
15. As a QA engineer, I want a fixture that auto-title does not run when title is already custom, so that L1 holds.

---

## Implementation Decisions

1. **API:** `PATCH /api/node/ledger/conversations/{id}/title` with body `{ title, only_if_default? }`; resolve owner via conversation; return `{ ok, skipped?, title, before?, conversation_id }`.  
2. **Write helper:** shared `writeConversationTitle` (PATCH + `conversation_title_updated`). Default still registers `platform_set_conversation_title` for user-asked rename; pentest / act-expert citizen prepend no longer includes it.  
3. **Envelope:** Platform attaches `conversation_title` when building `task_assign` (from Conversation row).  
4. **Harness auto path:** `applyHarnessAutoTitle` on Free Main start (`session-runner`). Graph stage / worker builders do not call it.  
5. **Task hint:** `node4/src/runtime/session-title.ts` `formatSessionTitleHint` — assembled into Free/Default Main Task by `buildPromptLayers`. Auto path says harness will name it; Default may mention the tool for user-asked rename. Graph stage / worker Task builders omit the hint. Platform does not regex-extract a URL from the utterance.  
6. **Frontend:** Handle `conversation_title_updated` (bypass case gate so sidebar updates); existing Sidebar manual PATCH unchanged.  
7. **Placeholders:** Shared server frozenset + Node helper for default detection.  
8. **Ship separately from #454:** own Spec, issue, and PR.

---

## Testing Decisions

- **Good tests:** only_if_default skip when title custom; empty title rejected; placeholder membership; tool registered on default seat and **absent** on pentest; harness write from structured envelope; Task hint (placeholder+target → harness write; greeting without target does not; custom title skips).  
- **Prior art:** `test_conversation_title_node.py`, `platform.policy.test.ts`, `node4/src/runtime/session-title.test.ts`, `node4/src/runtime/prompt-layers.test.ts`.  
- **Optional e2e:** create Case → send substantive message with target → title leaves「新会话」(manual or integration).

---

## Out of Scope

- A second Participant Session / UI participant for naming.  
- Platform-side keyword/NLP title tables on free text.  
- Platform-side non-Agent LLM title generation.  
- Renaming other Cases from this tool.  
- Full history of title changes UI.  
- Owner ledger (#454) or Task dialogue packaging (#455).  
- Translating titles by node language policy (may follow user language; not a hard gate here).

---

## Further Notes

Design.md already described auto-naming; this Spec freezes harness write + only_if_default as the persist path. Auto-title is a harness write on Free Main — not a dedicated naming Session and not an Agent tool turn on pentest.

## Changelog

| Date | Change |
|------|--------|
| 2026-08-15 | First publish — #457. |
| 2026-08-16 | Auto-title moved onto Main Task-layer hint; no housekeeping Session (#482). |
| 2026-08-31 | Auto path is a harness write; pentest drops the title tool (#548). |
