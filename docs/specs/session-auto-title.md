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

Operators want the **Agent** (any product seat that participates, including Default) to infer a **short, useful title** from the first real task message and write it to the Case title (sidebar + top bar), without forcing a manual rename every time.

Constraints:

- Pure greetings must **not** burn the default title.  
- User-chosen titles must **not** be overwritten silently.  
- Title changes must not spam the chat timeline.  
- Platform must **not** invent titles via keyword/NLP tables on free text (Agent judgment + explicit tool write only).

---

## Solution

1. **Default remains「新会话」** (and known English placeholders) at Case create.  
2. **Agent tool** `platform_set_conversation_title` updates **this** conversation’s title via Node-authenticated ledger API.  
3. **Auto path:** when the current title is still a default placeholder and the user message is a **substantive task**, the Agent calls the tool once with `only_if_default=true` and a short title (target / unit / task type). Prefer **silent** (no chat narration).  
4. **Explicit rename:** user asks to rename → tool with `only_if_default=false`.  
5. **Live UI:** after success, Node emits `conversation_title_updated`; frontend patches the conversation store (sidebar + top bar) without full reload.  
6. **Wire:** `task_assign` may include `conversation_title` so the Agent knows the current placeholder without an extra read.  
7. **Manual rename** in Sidebar (existing PATCH) remains; after that, auto path skips.

### Product locks

| # | Lock |
|---|------|
| **L1** | Auto-title only when current title is a **default placeholder** (`only_if_default=true` server-enforced). |
| **L2** | Placeholders include at least: `新会话`, `New session`, `Untitled`, `未命名会话`, empty/whitespace. |
| **L3** | Pure greeting / small-talk turns **must not** auto-title. |
| **L4** | Title length: short (product guidance ≤~24 Chinese chars or ~40 Latin); server max 255; non-empty. |
| **L5** | No platform free-text keyword table inventing titles; Agent authors title; tool persists. |
| **L6** | `conversation_title_updated` is **not** a chat timeline message (do not persist as agent chat row). |
| **L7** | User manual rename and explicit Agent rename always allowed when not restricted by empty title. |
| **L8** | Tool is scoped to the **current** `conversation_id` on the task (no cross-Case rename). |
| **L9** | Available on Default and citizen-inherited seats (any pack that can act in a Case). |
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
9. As an Expert Agent, I want `conversation_title` on the task envelope, so that I know when the title is still default.  
10. As an Expert Agent, I want `only_if_default` on the tool, so that retries do not clobber user titles.  
11. As a Default seat Agent, I want the same tool, so that handoff-only Cases still get titles before or with handoff.  
12. As a platform implementer, I want Node token auth on the title PATCH, so that only bound Nodes can write.  
13. As a platform implementer, I want audit optional/lightweight, so that title churn is not noisy (may share conversation.update patterns).  
14. As a QA engineer, I want unit tests for placeholder detection and only_if_default skip, so that L1/L2 hold.  
15. As a QA engineer, I want a fixture that auto-title does not run when title is already custom, so that L1 holds.

---

## Implementation Decisions

1. **API:** `PATCH /api/node/ledger/conversations/{id}/title` with body `{ title, only_if_default? }`; resolve owner via conversation; return `{ ok, skipped?, title, before?, conversation_id }`.  
2. **Tool:** `platform_set_conversation_title` on Node platform tools; citizen + default tool lists; on success send WS `conversation_title_updated`.  
3. **Envelope:** Platform attaches `conversation_title` when building `task_assign` (from Conversation row).  
4. **Prompts:** Short guidance in default / platform-citizen / ledger-assist session-runner: auto once with only_if_default; silent; greetings skip.  
5. **Frontend:** Handle `conversation_title_updated` (bypass case gate so sidebar updates); existing Sidebar manual PATCH unchanged.  
6. **Placeholders:** Shared server frozenset + Node helper for default detection.  
7. **Ship separately from #454:** own Spec, issue, and PR.

---

## Testing Decisions

- **Good tests:** only_if_default skip when title custom; empty title rejected; placeholder membership; tool registered on default seat.  
- **Prior art:** `test_conversation_title_node.py`, `platform.policy.test.ts`.  
- **Optional e2e:** create Case → send substantive message → title leaves「新会话」(manual or integration).

---

## Out of Scope

- Platform-side non-Agent LLM title generation.  
- Renaming other Cases from this tool.  
- Full history of title changes UI.  
- Owner ledger (#454) or Task dialogue packaging (#455).  
- Translating titles by node language policy (may follow user language; not a hard gate here).

---

## Further Notes

Design.md already described auto-naming; this Spec freezes Agent-tool + only_if_default as the product path (not a silent platform NLP table).
