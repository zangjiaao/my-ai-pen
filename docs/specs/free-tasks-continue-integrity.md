# Spec: Free Tasks progress SoT + continue integrity

**Status:** Implementable Spec (product contract)  
**Tracker:** [#313](https://github.com/zangjiaao/my-ai-pen/issues/313)  
**Decision source:** Product grill on Case `68a83c02-7b92-4a25-a611-ffa9edb11ad9` (Tasks open while work done; next_steps confirm → empty-target chat-only turn; `todo.init` 14→24 wipe); primary-source research `research/wayfinder-notes/omp-todo-management.md`, `research/wayfinder-notes/codex-grok-todo-management.md`.

**Product path:** Node4 Graph × Pi + platform conversation UI (ADR 0001). Free = Expert Participant Session without Graph runner.  
**Amends (thin):**  
- `docs/specs/participant-session.md` / Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) — queue: ChoiceCard confirm is a normal FIFO demand, same as user text.  
- `docs/specs/choice-card-next-steps.md` / Spec [#312](https://github.com/zangjiaao/my-ai-pen/issues/312) — next_steps single-select + optional supplement; value-only emission; confirm feed shape.  
- `docs/specs/task-graph.md` — Free Tasks = user progress SoT; Free `todo.init` replace policy (Graph stage-local merge unchanged).  

**Does not amend:** book-path L0, Finding Store, Expert Graph stage L2 Spec [#281](https://github.com/zangjiaao/my-ai-pen/issues/281) merge rules, intent NLP ban (`AGENTS.md`), pack Graph capability + user permission (no Expert caste).

---

## Problem Statement

Operators treating **Tasks** as “what the Agent still owes” saw many open items after a Free pentest turn that had already probed and booked findings. Separately, after the Agent offered a **next_steps** Choice Card and the operator chose **继续深入探测**, the product either delayed, lost target/scope, re-asked in chat-only mode, or replaced the task map with a brand-new zeroed list. The decision appeared in the transcript, but work did not continue as the same Session with the same progress truth.

From the operator’s view:

1. Tasks lied or lagged (work done, boxes open; or whole map wiped on continue).  
2. “I already chose” did not mean “keep going on that target with that intent.”  
3. Fixed-looking next-step menus and multi-select packages did not match “only suggest when it is worth doing.”

---

## Solution

1. **Free-mode Tasks are the user-visible progress source of truth** for that Participant Session’s checklist (not a disposable agent scratchpad).  
2. **Silent whole-map `todo.init` replace is forbidden** while the Session has meaningful prior todo state; continue work **merges** or mutates in place. Full replace requires **explicit user permission**. Declining replace still allows normal maintain ops (`append` / `start` / `done` / `drop`). **Successful replace archives** the prior map (does not discard it); sealed all-terminal maps and RightPanel revision history are Spec [#321](https://github.com/zangjiaao/my-ai-pen/issues/321) / [`task-map-history.md`](task-map-history.md).  
3. **Completion narrative is soft-aligned:** the Agent may offer next steps or say a phase is pausing **without** zeroing open todos, but must **honestly surface remaining open progress** (no “评估已完成” with a silent dirty map). Open todos do **not** hard-block harness settlement (avoids fake mass-`done`).  
4. **next_steps Choice Cards** are **agent-authored from prior work**, emitted only when valuable and purposeful; platform rejects empty/broken cards. **Single-select** primary direction; **custom last-row option** may stand alone (Spec #450).  
5. Confirm = **structured ids + full display text (option title/body and/or 自定义)** enqueued as a **normal FIFO Session demand** (same as user messages under Spec #277). Idle/out-of-queue delivery continues the **same Session** with sticky target/scope/expert and **without** empty-target chat-only bypass.  
6. Graph mode keeps existing stage-local L2 merge discipline; this Spec’s Free init/replace rules do not weaken Graph package-anchored history protection.

---

## Product locks (grill)

| # | Lock |
|---|------|
| L1 | Free Tasks panel / plan_tree from Free TodoStore = **user progress SoT** for checklist status. |
| L2 | Free **silent full `todo.init` replace forbidden** when prior phases/tasks exist (open or closed history the user still sees as this map). Continue = same map. |
| L3 | Free **full replace only after explicit user permission** (ChoiceCard or equivalent confirm). Graph stage-local init/merge stays Spec #281 / task-graph. |
| L4 | User **declines replace** → still may `append` / `start` / `done` / `drop` / `rm` per tool rules; only replace remains denied until later permission. |
| L5 | **Soft completion honesty:** next_steps / “pause / wrap narrative” allowed with open items **if** remaining progress is disclosed; no hard “open todos ⇒ refuse settle.” |
| L6 | next_steps options **from Agent judgment on work done**; **may omit** the card; **no fixed product template options** as primary UI. |
| L7 | Platform **fail-closed residual cards** only (0 options, missing body, invalid shape)—not “must always show N options.” |
| L8 | next_steps **single-select**; custom last-row answer may stand alone (Spec #450). |
| L9 | Confirm wire: `selected_option_ids` + `text` (titles/bodies + 自定义) → **same FIFO queue** as user messages; not a privileged priority class. |
| L10 | Dequeue / live wait deliver to **same Participant Session** with work context (target, scope, expert, existing Tasks); **forbid** empty-target “conversation only” continuation for a confirm that carried a prior engagement target. |
| L11 | Queue chrome: delete item / force-send-interrupt — same as any queued user demand (Spec #277 §3.4). |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Free Tasks map** | Session checklist from Free TodoStore / projected plan_tree when work_mode is Free. |
| **Silent init replace** | `todo` op `init` that discards prior phases without user-permission event. |
| **Replace permission** | Explicit user accept to replace the Free Tasks map. |
| **next_steps card** | ChoiceCard kind for curated next direction (amends #312 multi-select default). |
| **Supplement text** | Optional free text on the card chrome, merged into confirm `text`. |
| **Session demand queue** | Spec #277 queue of user intents while Session in-flight; FIFO; force/delete; cap 5 pending / Case. |
| **Honest pause** | Narrative/card that admits open checklist items rather than claiming full completion. |

---

## User Stories

1. As an operator, I want Tasks to reflect real remaining work, so that I trust the progress panel.  
2. As an operator, I want finished probes marked done promptly, so that open items mean unfinished work.  
3. As an operator, I want continue not to zero my checklist, so that I do not lose orientation after “继续.”  
4. As an operator, I want the Agent blocked from silently replacing the whole map, so that history is not wiped mid-Case.  
5. As an operator, I want to approve a new map only when I agree the plan should change, so that replan is deliberate.  
6. As an operator, I want to refuse a replan and still let the Agent add or close items, so that work can continue on the old map.  
7. As an operator, I want Graph stage todos to keep stage-local merge rules, so that Free policy does not break Graph.  
8. As an operator, I want next-step suggestions only when they are worth doing, so that I am not force-fed empty menus.  
9. As an operator, I want each suggestion grounded in what was already done, so that choices are purposeful.  
10. As an operator, I want the product to skip the card when nothing valuable remains, so that silence is allowed.  
11. As an operator, I want broken or empty cards rejected, so that I never click hollow options.  
12. As an operator, I want a single primary next direction, so that intent stays clear.  
13. As an operator, I want an optional text box on the card, so that I can add constraints without multi-select soup.  
14. As an operator, I want my selection shown as a clear user summary in the transcript, so that history records the decision.  
15. As an operator, I want that selection treated like my own message on the Session queue, so that behavior matches ordinary chat.  
16. As an operator, I want queued confirms to wait while the Agent works, so that I do not interrupt by default.  
17. As an operator, I want to delete a queued confirm, so that I can change my mind before it runs.  
18. As an operator, I want force-send to interrupt and apply the demand, so that urgent redirects still work.  
19. As an operator, I want FIFO order shared with ordinary messages, so that queue rules stay simple.  
20. As an operator, I want after confirm the same Expert Session continues, so that persona and memory stay continuous.  
21. As an operator, I want target and scope preserved on confirm continue, so that I am not dropped into targetless chat.  
22. As an operator, I want existing Free Tasks retained across confirm continue, so that progress is not reset to 0/N.  
23. As an operator, I want restart or dead wait not to swallow my confirm, so that the intent still reaches the Session via queue or direct feed.  
24. As an operator, I want empty-target chat-only continue forbidden when I confirmed a next step on a known target, so that the product cannot “re-ask” as if nothing happened.  
25. As an operator, I want wrap-up text to admit remaining open Tasks, so that “告一段落” is honest.  
26. As an operator, I want next_steps allowed while some todos remain open, so that I can choose deepen without fake-closing the map.  
27. As an operator, I want settlement not hard-blocked solely by open todos, so that agents do not mass-skip to escape.  
28. As an operator, I want mid-run and stop soft reminders for stale todos to remain available, so that forget-to-check improves without hard gates.  
29. As an Expert Agent author, I want clear tool errors when init replace is denied, so that I can append or request permission instead.  
30. As an Expert Agent author, I want confirm text to include option bodies, so that I need not recover meaning from ids alone.  
31. As a platform implementer, I want one demand path for text and confirm, so that orphaned special-cases die.  
32. As a platform implementer, I want residual validation only on card shape, so that the platform does not invent option content.  
33. As a QA engineer, I want fixtures for busy-queue confirm, so that FIFO is regression-tested.  
34. As a QA engineer, I want fixtures for init-replace denied, so that wipe-on-continue cannot return.  
35. As a QA engineer, I want fixtures for single-select + supplement, so that multi-select default does not regress.  
36. As an operator, I want declined replace not to freeze the map, so that append/done still work.  
37. As an operator, I want Graph package-anchored L2 history still protected, so that Free rules do not leak into Graph wipe.  
38. As an operator, I want interrupt of the Session to show interrupted honestly, so that I know when to re-engage.  
39. As an operator, I want after interrupt my queue retained until deleted or delivered, so that confirms are not lost by stop alone.  
40. As an operator, I want multi-select next_steps retired as the product default, so that purpose stays single-threaded.  
41. As an operator, I want authorize/handoff cards unchanged in two-button form, so that RoE path is not confused with next_steps.  
42. As an operator, I want Workset binds on options still optional, so that inventory binding remains possible without being the choice chrome.  
43. As an operator, I want no platform keyword detection inventing next_steps content, so that AGENTS.md intent rules hold.  
44. As an operator, I want Free map size discipline encouraged by soft harness (not product-fixed phase names), so that huge stale maps are discouraged without hardcoded OWASP lists.  
45. As a reviewer, I want living docs cross-links, so that #277/#312/task-graph stay consistent.

---

## Implementation Decisions

1. **Primary product seam (S1):** Session user-demand intake (message and ChoiceCard confirm) → Session demand queue when in-flight → dequeue or live wait delivery → same Participant Session continue with work envelope (expert, work_mode, graph_id if any, sticky target/scope). One path; no separate “orphaned confirm empty chat” success path for confirms that should continue engagement work.  
2. **Secondary seam (S2):** Free Todo mutation policy on `init` / replace vs merge-friendly ops (`append`, `start`, `done`, `drop`, `rm`, `view`). Graph path keeps stage-local merge and package-anchor protection.  
3. **Tertiary seam (S3):** next_steps card validate + confirm payload builder (single selected id, optional supplement → `text` + `selected_option_ids`).  
4. **Queue:** Confirm is `enqueue` by default when Session busy; same FIFO as text; delete/force-send shared chrome; no decision priority class.  
5. **Live wait:** When a next_steps/authorize wait is still owned by the live Session, forward feedback into that wait (existing permission path). When wait is dead but Session busy or idle, treat confirm as queueable/normal demand with full text—not a no-op.  
6. **Work context on continue:** Continue dispatch must rehydrate sticky target/scope/expert from Case/Session; if prior turn had a non-empty engagement target, confirm continue must not enter targetless conversation-only mode.  
6b. **Free cold continue Todo seed:** When Free cold-starts a new `task_id` (park miss, model fail, Node restart) and the same expert still has **open** Case Tasks (participant / checkpoint `plan_tree`), platform attaches `pending_handoff_todos` on `task_assign` so Node `seedTodoFromHandoff` restores that map into TodoStore **before** the Agent runs. Sealed (all-terminal) maps are not seeded (fresh `init` allowed). Graph `graph_execution=full|resume` and `work_mode=graph` skip this seed. Session-delete hold sets `pending_handoff=true` (and still wins when present); **park attach remains primary** and must not be dropped merely because cold-seed todos are on the wire. This closes the hole where an empty runtime TodoStore made silent `todo.init` replace succeed while the right-panel Tasks still showed the prior plan.  
7. **Free init policy:** If Free map non-empty (any phase with tasks, including completed still on the working projection), `init` full replace **errors** unless a **platform-issued** user-permission grant is present on that turn. Contract (L3):
   - User confirms via ChoiceCard option id **`replace_todo_map`** or FE sets structured **`todo_replace_permission: true`** after a dedicated option (no free-text NLP).
   - Platform sets a one-shot grant → `todo_replace_allowed: true` on `task_assign` (or `todo_replace_permission` on live `user_input`); Node Free Main `todo` tool allows replace only when that grant is present. **Agent `allow_replace` alone is denied.**
   - After one successful Free replace init, grant is consumed (cannot re-wipe without a new user confirm).  
8. **After decline replace:** tool surface still allows maintain ops; only replace remains gated.  
9. **Soft honesty:** Prompt/harness copy for Free must require disclosing open counts or titles when offering next_steps or pause narrative; stop/mid-run todo reminders may remain; **no** settlement refuse solely because open todos remain.  
10. **#312 amendments:** Default next_steps **single-select**; multi-select no longer product default for next_steps; optional supplement control on card chrome; L2 emission guidance = valuable/purpose-clear only (Agent), not “always at settle.” Soft gate for missing card may remain but must not invent options.  
11. **#277 amendments:** Explicit row: ChoiceCard confirm is a Session demand like user text (FIFO). No change to Free/Graph mode authority.  
12. **task-graph amendments:** Free TodoStore checklist = user progress SoT; Free silent init wipe forbidden; Graph L2 rules unchanged.  
13. **UI projection:** Tasks panel continues to project plan_tree/todo phases; after denied wipe, progress label must not jump to a brand-new 0/N map without user replace permission. After **allowed** replace or sealed→init, prior map is archived and selectable per Spec [#321](https://github.com/zangjiaao/my-ai-pen/issues/321).  
14. **No hardcoded option catalogs** for next_steps in platform code (AGENTS.md / no hardcoded behavior without approval).  
15. **OMOP/OMP-aligned soft loops** (echo remaining list on todo ops, mid-run nudge, stop incomplete reminder) remain desirable but are **supporting**; this Spec’s hard rules are L2–L4, L9–L10.

---

## Testing Decisions

**Good tests** assert external behavior at S1–S3: observable queue order, continue envelope fields, todo op accept/reject, card confirm payload, and user-visible progress—not internal helper names.

| Seam | Example external behaviors |
|------|----------------------------|
| S1 | Busy Session + confirm → queued; idle → same expert + non-empty target retained; dead wait + confirm still delivers demand; force-send interrupts then applies; delete removes before run. |
| S2 | Free non-empty map + `init` without permission → error, state unchanged; `append`/`done` succeed; with replace permission → init allowed; Graph stage merge regressions still pass. |
| S3 | next_steps validate rejects empty options; confirm builds text with title/body/supplement; single selection only; authorize preset still two-button. |

**Prior art:** platform tests for participant session / choice card / composer bind; Node4 todo store and hard-graph plan merge tests; WS user_decision paths.

**Fixtures:** Prefer synthetic conversation envelopes and pure todo transitions over live LLM.

---

## Out of Scope

- Changing Finding Store / book-path L0 or vuln identity.  
- Making open todos a hard settlement or booking gate.  
- Redesigning Graph L1 stages or package settlement honesty.  
- Adding Graph JSON to packs that do not declare graphs (this Spec does not mint Graph capability).  
- Mechanical right-panel Next resurrection.  
- Priority queues, decision-only queues, or multi-select next_steps as default.  
- Fixed product-authored next_steps templates (four canned buttons).  
- RabbitMQ node-offline transport redesign (orthogonal).  
- Auto-marking todos done from shell heuristics without Agent/tool ops (no fake intelligence).

---

## Further Notes

- **Why not only #277:** Session/queue skeleton already exists; this Spec adds Free progress SoT, init replace gate, and next_steps confirm integrity without reopening mode law.  
- **Why not only #312:** Card UX alone does not stop Free `todo.init` wipe or empty-target continue.  
- **Industry contrast:** OMP/Codex/Grok treat checklists as largely voluntary with soft nudges; product Free Tasks are **stronger SoT** for wipe and continue integrity, still **soft** on settlement (L5).  
- **Incident anchor:** Case `68a83c02-…` — 2/14 then init 0/24; confirm `continue_deep` then targetless “刚才选了…” chat turn.

---

## Test seams (normative)

| ID | Seam | Role |
|----|------|------|
| **S1** | Session demand queue + continue dispatch (message ∪ confirm_options) | Primary |
| **S2** | Free todo mutation policy (init/replace vs maintain) | Secondary |
| **S3** | next_steps validate + confirm payload | Tertiary |

Ideal: implementers hang behavior on these three seams only—no fourth policy kernel.
