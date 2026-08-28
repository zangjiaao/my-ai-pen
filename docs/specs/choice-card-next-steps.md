# Spec: Unified Choice Card (next steps + authorize)

**Status:** implemented (vertical slice; review fixes applied; soft-gate on assign; no hard gate) — **amended by Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313)** (Free continue integrity) and **[#450](https://github.com/zangjiaao/my-ai-pen/issues/450)** (Approval wizard chrome; custom is a last-row peer option, not a supplement)  
**Tracker Spec (to-spec / `ready-for-agent`):** [#312](https://github.com/zangjiaao/my-ai-pen/issues/312); amend [#313](https://github.com/zangjiaao/my-ai-pen/issues/313)  
**Related:** Spec [#311](https://github.com/zangjiaao/my-ai-pen/issues/311) Case Workset / Goal outer; `docs/specs/harness.md` Settle; `ConfirmCard` / `request_user_decision`; product-state UI projection [#280](https://github.com/zangjiaao/my-ai-pen/issues/280); Free Tasks SoT [`free-tasks-continue-integrity.md`](free-tasks-continue-integrity.md)

**Product path:** Node4 Graph × Pi + platform conversation UI  
**Does not implement product code in this document** — normative contracts only.

**Decision source:** product grill (ChoiceCard / retire mechanical Next UI), conversation on Case `9594f704-…` (agent cannot see right-panel Next; empty A/B/C/D handoff).

---

## Problem Statement

Operators see **fine-grained Next / Workset items** (many API paths, adopted/proposed) on a side panel or mechanical chip bar, while the Agent:

1. Declares Todo complete and “waits for instructions,”  
2. Does **not** reliably receive Workset as curated next work,  
3. Asks the user to pick prose A/B/C/D directions that ignore the panel.

That is **not** a decision UI: too many raw endpoints, no narrative “why this next,” and **multiple competing option surfaces** (ConfirmCard, WorksetChoiceBar, WorksetNextList, handoff banner, free-text menus).

Operators need **a few thoughtful choices** in the chat stream—like a grill-me option set: short title, explanation, multi-select work packages—not an inventory multi-select of every surface key.

---

## Solution

1. **Agent-curated** structured **Choice Cards** in the **Main conversation stream** (same product language as authorize/handoff cards).  
2. **One shared chrome** (`ChoiceCard`): title, markdown body/preamble, options, primary CTA.  
   - **`authorize` / handoff** preset → today’s ConfirmCard behavior (授权 / 取消).  
   - **`next_steps` preset** → Approval wizard chrome (Spec #450): radio/check rows, **custom last-row option** (may stand alone), Send submits, ✕ cancels. Single-select default (Spec #313). Confirm continues the Session.  
3. Each next_steps option has **title + required body** (why / what / success shape) and **optional** `workset_item_ids[]` (0..n) to bind Case Workset rows without listing every API as its own chip. Options are **agent-authored from prior work**; emit **only when valuable/purpose-clear** (may omit). Platform rejects empty/broken cards — does **not** supply fixed template options.  
4. User confirm → **structured `user_decision`** (`selected_option_ids` + full `text` including option title/body + optional supplement) + visible “已选择…” summary; demand is **FIFO Session queue** same as user text (#277 / #313).  
5. Card **stays in history**; after user continues the conversation without using the card (or after answering), **controls become read-only**.  
6. **Retire** right-panel Next and mechanical `WorksetChoiceBar` / `WorksetNextList` as user-facing choice UIs.  
7. Case **Workset remains SoT** for pending admission (deepen / OOS / passive exposure), Goal outer, and option binding—not a second choice chrome. Legacy `next_scope_candidates` arrays are merge inputs only ([#540](https://github.com/zangjiaao/my-ai-pen/issues/540)).  
8. **Soft gate** when settle/continue should have offered next_steps but did not (prompt retry once; no platform-fake option card).

---

## Product locks (grill)

| # | Lock |
|---|------|
| L1 | Options **authored by Agent** (not platform keyword/inventory expansion as primary UI). |
| L2 | Emit when Agent judges **valuable next work** exists (may omit); soft retry when a boundary expected a card but none arrived — **no** fixed “always four options.” Spec #313. |
| L3 | Unified **ChoiceCard** shell; Confirm is a preset. |
| L4 | **next_steps** default **single-select** (Spec #313); custom is a **peer option** (Spec #450), not a supplement. Authorize/handoff use the **same wizard** as yes/no (授权/取消) + custom; no recommended badge. Multi-select is not the product default. |
| L5 | Card is a **message in the stream** (not sticky-only chrome). |
| L6 | Option fields: `id`, `title`, `body`, optional `workset_item_ids[]`, optional coarse `kind`. |
| L7 | Confirm path: structured decision + visible summary (not silent-only). |
| L8 | Missing card: **soft gate** (one retry inject); no mechanical fake card as SoT. |
| L9 | Unanswered card becomes **read-only** after user continues dialogue without selecting; answered cards also read-only; cards remain on page. |
| L10 | **Retire** mechanical Next panel / WorksetChoiceBar as primary UX. |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Choice card** | Agent-authored structured user decision message in Main chat. |
| **next_steps** | Choice kind: curated work packages after a stoppable boundary. |
| **authorize** | Choice kind: RoE / handoff / confirm (existing ConfirmCard law). |
| **Work package option** | One selectable row: narrative + optional Workset id binds (may cover many surfaces). |
| **Case Workset** | Platform Case backlog (`proposed`/`adopted`/…); inventory SoT, not the choice UI. |
| **Soft gate** | Host/prompt retry when a boundary required a card but none arrived; does not invent options. |

---

## User Stories

1. As an operator, I want a few clear next-step choices when a run can stop, so that I am not dumped into “等待指示” with a useless side list.  
2. As an operator, I want each choice explained (why / what), so that I can decide without reading raw API inventory.  
3. As an operator, I want multi-select of work packages, so that I can continue several related threads in one turn.  
4. As an operator, I want options to bundle many surfaces under one package, so that I am not ticking every endpoint.  
5. As an operator, I want choices in the chat transcript, so that I can see what was offered later.  
6. As an operator, I want answered or superseded cards to stay visible but non-interactive, so that history is honest.  
7. As an operator, if I ignore a card and type free text, I want the card to freeze as read-only, so that I do not click stale actions later.  
8. As an operator, I want authorize/handoff cards to look like the same family as next_steps, so that the product does not feel like three apps.  
9. As an operator, I want “按所选继续” to actually drive the next agent turn, so that I am not asked A/B/C/D again.  
10. As an operator, I want OOS host packages to state Scope implications in the body, so that I never silent-expand RoE.  
11. As an operator, I want no right-panel Next list, so that attention stays on Main chat decisions.  
12. As an operator, I want Workset to still exist for Goal/outer inventory, so that deepen candidates are not lost as product state.  
13. As an agent runtime, I want a structured schema for next_steps, so that I can emit valid cards without free-text tables.  
14. As a platform host, I want to soft-retry when a boundary lacks a card, so that empty idle is reduced without hard-blocking weak models forever.  
15. As a platform host, I want user_decision to carry selected option ids and resolved workset ids, so that continue is not NLP-only.  
16. As an operator, I want a short “已选择：…” bubble, so that the transcript shows my decision.  
17. As an operator, I want at most a small number of open interactive next_steps cards (product: prefer latest open; freeze older on new dialogue), so that I do not click expired packages.  
18. As a developer, I want one FE shell for choices, so that we stop inventing WorksetChoiceBar-like chrome.  
19. As a developer, I want pure validation of card payloads, so that tests do not need full browser.  
20. As an operator, I want report-only or prior-reverify options without workset ids, so that not every choice is surface-bound.  
21. As an operator, when Goal is stopped but Workset still has open items, I want the agent to surface next_steps instead of claiming total completion only from Todo counts.  
22. As an agent, I want case_context to include enough next_work refs, so that options can bind Workset honestly.  
23. As an operator, I want disabled state while a turn is running, so that I do not double-submit.  
24. As an operator, I want cancel/dismiss of next_steps only if product provides an explicit control (V1: free-text continue freezes card; no silent discard of Case Workset).  

---

## Implementation Decisions

### Modules (logical)

- **Agent Runtime (Node4):** emit structured choice messages; stoppable-boundary and continue-empty prompts; consume user_decision selected ids.  
- **Platform WS / conversation:** persist choice messages; accept user_decision for next_steps; project to FE; optional soft-gate inject on assign/continue.  
- **Platform Case Workset:** remains inventory SoT; options may reference item ids; no requirement that UI list every item.  
- **FE conversation:** unified ChoiceCard shell; authorize preset + next_steps multi-select; retire WorksetChoiceBar mount and right-panel Next; freeze card on free-text continue (parity with confirm answered).  
- **case_context / Node parse:** carry next_work / choice-related thin refs so Agent can see open Workset when curating (fix earlier gap: platform `next_work` dropped by Node parse).

### Message / decision shape (normative intent)

```text
choice_card | confirm_card (compat):
  request_id: string
  kind: "authorize" | "handoff" | "next_steps" | …
  selection: "single" | "multi"   # next_steps default single (Spec #313); authorize N/A (two fixed actions)
  # Spec #450: custom_text is a peer answer (not a supplement hanging on an option)
  preamble?: markdown
  question?: string               # authorize title
  options?: [                     # next_steps
    { id, title, body, workset_item_ids?: string[], kind?: string }
  ]
  # authorize continues existing fields: proposed_action, handoff_*, target, …

user_decision:
  request_id: string
  decision: "authorize" | "cancel" | "answered" | "confirm_options"
  selected_option_ids?: string[]  # next_steps
  # platform may expand selected_option_ids → workset_item_ids for task_assign
```

(Exact wire names may alias existing `confirm_card` / `request_user_decision` if migration is cheaper—behavior locks above win.)

### Caps / validation

- next_steps: **2–5** options; each **title + body** non-empty; option ids unique per card.  
- Soft gate: at most one retry inject per boundary event (no inject storm).  
- Do not platform-synthesize option bodies from Workset titles alone as the primary product path.

### Retirement

- Remove user-facing **WorksetChoiceBar** and right-panel **Next** list as product surfaces.  
- WorksetNextList may be deleted or left unmounted; no new features there.  
- caseHandoff pack banner remains separate until absorbed into authorize/handoff ChoiceCard (optional follow-up, not required for V1 next_steps).

---

## Testing Decisions

**Good tests** assert **external behavior** of pure contracts and message projection—not Tailwind class strings or internal React state.

### Primary seams (prefer existing; minimize new)

| Seam | External behavior |
|------|-------------------|
| **S1 Choice payload validate (pure)** | Accept/reject next_steps shapes (count, required body, ids); authorize still valid. Prefer pure function at platform or Node boundary (same spirit as workset/traffic pure tests). |
| **S2 User decision expand (pure)** | `selected_option_ids` + card snapshot → resolved workset ids / continue brief. |
| **S3 Soft-gate predicate (pure)** | Inputs: boundary kind, open workset count / open priors flag, whether legal choice present, whether turn had tools → inject or not. |
| **S4 FE card contract** | Given fixture message, multi-select confirm emits expected decision payload; free-text continue freezes controls (mirror ConfirmCard answered tests if present). |
| **S5 case_context parse/format** | Node retains and formats next_work / choice-relevant refs so Agent can curate (regression for drop-on-parse). |

**Prior art:** `test_case_workset.py` (thin_handoff_brief, project), `ConfirmCard` / conversation decision handling, `case-context.test.ts`, harness settle tests, FE pure lib tests via `tsx`.

**Avoid:** E2E as only seam; snapshotting full LLM prose.

---

## Out of Scope

- Hard gate that blocks all task_complete without a card (may be later flag).  
- Platform-only fake next_steps cards as product default.  
- Right-panel Next revival.  
- Per-endpoint inventory multi-select as primary UX.  
- Full modal-only choice UX.  
- Absorbing every composer banner (pack handoff chip) in V1 (optional later).  
- Changing Goal outer math except soft-gate hooks at assign/continue.  
- MITM traffic / Worker audit redesign.

---

## Further Notes

- **Why not WorksetChoiceBar:** it is inventory multi-select without Agent narrative; contradicts “thoughtful options.”  
- **Why keep Workset:** Goal outer, deepen inventory, optional binds; Case state remains honest even when UI shows 3 packages not 20 paths.  
- **Parity with user pain:** Case `9594f704-…` — Todo 20/20 + open adopted Workset + agent A/B/C/D menu; this Spec targets that class of failure.  
- **AGENTS.md:** no free-text keyword intent invention; choice content is Agent-structured or explicit user decision.  
- Living doc updates in same change as behavior: this file, `harness.md` Settle row, `docs/README.md` index, retire notes for FE surfaces.

---

## Testing seams check (for implementers)

Confirm before coding if product still agrees:

1. **S1** pure payload validate as highest shared seam.  
2. **S3** soft-gate pure predicate.  
3. **S5** Node case_context must not drop next_work / choice refs.  

If product wants hard gate or dual FE surfaces, reopen L8 / L10 before implementation.
