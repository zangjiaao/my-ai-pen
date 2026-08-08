# Spec: Task Map history (archive + revision select)

**Status:** Implemented (S1–S3 Free + Graph participation map + RightPanel history view)  
**Tracker:** [#321](https://github.com/zangjiaao/my-ai-pen/issues/321)  
**Decision source:** Product grill (RightPanel Tasks overwrite; archive-then-switch; Free + Graph unified map lifecycle).

### Living status

| Seam | Behavior now |
|------|----------------|
| **S1** Free lifecycle | `TodoStore` + `TaskMapHistory` — E1 seal, E2 sealed→init archive, E5 maintain, E6 no auto-archive (`node4/src/stores/task-map.ts`) |
| **S2** Replace | #313 grant still required for open+init; success **archives** prior map; sealed path grant-free |
| **S3** Projection | `plan_tree_updated` + participant context + conversation snapshot expose `task_map_revisions` / `live_revision_id` |
| **S3** UI | RightPanel Tasks header selector + 历史·只读 + 返回当前 (`TasksMapHeader`) |
| **Graph** | Whole participation = one live map; stage advance mutates live only; Graph start archives prior Free/Graph map (E4) |

**Product path:** Node4 Graph × Pi + platform conversation UI (ADR 0001).  
**Amends (thin):**  
- `docs/specs/free-tasks-continue-integrity.md` / Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313) — full replace still permission-gated when open items exist; **successful replace archives** the prior map instead of discarding it; **sealed** full-terminal map allows a follow-on `todo.init` **without** a new replace grant.  
- `docs/specs/task-graph.md` — Task Map lifecycle is **one live map per Participant Session** (map revisions); Free and Graph share the same archive/view rules; history row ≠ per-stage L2.  
- `docs/specs/graph-stage-todo-l2.md` / Spec [#281](https://github.com/zangjiaao/my-ai-pen/issues/281) — Graph stage-local L2 **mutations** unchanged; stage end does **not** mint a history row; whole Graph participation is one map while alive.  
- `docs/specs/participant-session.md` / Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) — Session remains identity; **map revision list** hangs on the Session (A1).  
- `docs/specs/product-state-ui-projection.md` / Spec [#280](https://github.com/zangjiaao/my-ai-pen/issues/280) — Tasks panel projects **live** map by default + optional historical revision view.  
- `docs/specs/case-status-ledger-time-ui.md` / Spec [#323](https://github.com/zangjiaao/my-ai-pen/issues/323) — Task Map archive/seal **must not** reset Case token or work-seconds ledger (metering independent of map revisions).

**Does not amend:** Finding Store / book-path L0, intent NLP ban (`AGENTS.md`), Default seat never-Graph, next_steps card policy beyond replace permission ids already in #313.

---

## Problem Statement

Operators use the RightPanel **Tasks** section as orientation for what work is in flight. Today the panel is a single live projection: when the Agent re-inits or replaces the checklist (even after permission under Spec #313), the previous map is **gone**—not browsable. Completing a whole participation and starting a new plan feels like overwrite, not “record then hand the panel to the next map.” Free and Graph also risk diverging policies (stage snippets vs whole engagement), which confuses “what is one map?”

From the operator’s view:

1. Finished or replaced work should remain **reviewable**, not silently lost.  
2. Unfinished work on the **same** participation should still be **updated/appended**, not replaced by a fresh zeroed list.  
3. A truly different plan (or restart Graph) should **archive** the old map and give the panel to the new one—after explicit permission when open items remain.  
4. Free and Graph should share **one** map lifecycle mental model, not special-case stage micro-history in the dropdown.

---

## Solution

1. Introduce **Task Map** as the user-visible checklist unit for a **Participant Session**: exactly **one live map** occupies RightPanel Tasks while the participation is active.  
2. **Archive-then-switch:** when a map is sealed or replaced under policy, the prior map becomes a **frozen historical revision** (read-only); a new live map takes the panel.  
3. **RightPanel Tasks header** gains a **revision selector** (dropdown) so the operator can open historical maps without mutating them. Agent todo ops always target **live**.  
4. **Unified Free + Graph lifecycle** (not per-stage history rows):  
   - Free: one whole Free checklist = one map.  
   - Graph: **whole Graph participation** = one map while alive (stage advance stays **inside** the live map; #281 stage-local todo rules still apply to mutations).  
5. **State machine (normative events):**

| ID | Event | Effect |
|----|--------|--------|
| **E1** | Live map work items all **terminal** | Mark map **`sealed`**. Do **not** mint a new revision yet; completed map **still occupies** the panel (progress complete / read-oriented). |
| **E2** | First `todo.init` (or equivalent full map load) while live is **`sealed`** | **No** replace-permission grant required. Archive sealed map → new live revision. |
| **E3** | Full replan / replace while open (non-terminal) items exist | **Requires explicit user permission** (same class as #313 `replace_todo_map` / platform one-shot grant). On success: archive prior map (may include open items as frozen debt) → new live. Agent cannot self-grant. |
| **E4** | Explicit user **restart Graph** / re-enter Graph as a new participation map | Same class as user-authorized map switch: archive current map → new live (new Session or same Session new revision per product restart path; identity remains Session + revision). |
| **E5** | Continue, append, start, done, drop, stage advance, Graph L2 merge | **No** history row; mutate **live** only. |
| **E6** | Session settle / interrupt / park without seal | **Do not** auto-archive solely because the Session stopped. Last live remains the Session’s current map for resume/review unless E1–E4 applied. |

6. **Seal predicate (unified):** a map is sealable when **every user-visible work item** on that map is terminal (`done` / `drop` / product-equivalent terminal). Agent narrative “评估完成” alone does **not** seal. If L1 stage is failed/blocked but L2 open items remain, **refuse auto-seal** until those items are closed or dropped (no sweeping unfinished debt into history via stage fail alone).  
7. **History view:** selecting a historical revision is **display-only**; chrome marks **历史 · 只读**; provide **返回当前**. Live updates do not force the viewport off a historical selection.

---

## Product locks (grill)

| # | Lock |
|---|------|
| L1 | **One live Task Map** per Participant Session occupies Tasks; archive-then-switch, never multi-live write targets. |
| L2 | **History row unit** = whole Free map **or** whole Graph participation—not per-stage revision list. |
| L3 | Identity = **Participant Session + map revision list (A1)**; Case may show multiple Sessions’ maps over time via Session scope. |
| L4 | Unfinished same-thread work → **update/append** on live; silent full replace **forbidden** (#313). |
| L5 | Open items + full replan → **user permission required**; then archive + new live. |
| L6 | All-terminal → **`sealed`** automatically; panel keeps showing sealed map until E2/E3/E4. |
| L7 | **`sealed` + next full init** → archive without new replace grant (E2). |
| L8 | Stage end / Graph internal advance → **E5 only** (no history mint). |
| L9 | Session settle/interrupt alone → **E6** (no auto-archive). |
| L10 | Dropdown history = **read-only view**; mutations always on live. |
| L11 | Free and Graph share this lifecycle; Graph L2 stage-local **mutation** rules stay #281. |
| L12 | No free-text NLP to invent replace intent; structured permission only. |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Task Map** | User-visible progress checklist bound to a Participant Session (Free whole list or whole Graph participation projection). |
| **Live map** | The single writable Task Map revision currently owned by the Session; default RightPanel projection. |
| **Map revision** | Immutable snapshot entry in the Session’s revision list after archive (or the current live entry). |
| **Archive-then-switch** | Freeze prior revision read-only, then install a new live revision. |
| **Sealed** | Live map has all user-visible work items terminal; waiting for next plan load (E2) or explicit replace (E3/E4). |
| **Historical view** | UI-only selection of a non-live revision; not a second write target. |
| **Replace permission** | Platform-issued one-shot grant for E3 (and E4 when modeled as replace); agent self-flag insufficient (#313). |

---

## User Stories

1. As an operator, I want completed Task Maps retained, so that finished work is not lost when a new plan starts.  
2. As an operator, I want a dropdown on the Tasks header, so that I can pick which map revision to inspect.  
3. As an operator, I want the live map to stay the default view, so that I always know what is currently owed.  
4. As an operator, I want historical maps marked read-only, so that I do not think I can still check them off.  
5. As an operator, I want a clear “返回当前” control, so that I can leave history without hunting.  
6. As an operator, I want viewing history not to steal focus back to live on every token, so that I can read in peace.  
7. As an operator, I want Agent todo changes to always apply to live, so that progress truth stays single.  
8. As an operator, I want unfinished work updated or appended on the same map, so that continue does not zero my checklist.  
9. As an operator, I want silent whole-map init blocked while items remain open, so that Agents cannot wipe orientation.  
10. As an operator, I want to approve a full replan when the job truly changes, so that replan is deliberate.  
11. As an operator, I want the old map archived on approved replan, so that replace is not total amnesia.  
12. As an operator, I want open items frozen into that archive when I approve replan, so that abandoned debt remains auditable.  
13. As an operator, I want declining replan to leave the live map intact, so that maintain ops still work (#313).  
14. As an operator, I want a fully terminal map to auto-seal, so that “done” is objective.  
15. As an operator, I want a sealed map to keep occupying the panel until a new plan loads, so that I still see 完成态 progress.  
16. As an operator, I want the next init after seal to open a new live map without another replace prompt, so that starting the next chapter is smooth.  
17. As an operator, I want Agent “评估完成” alone not to seal the map, so that narrative cannot fake completion.  
18. As an operator, I want Graph stage completion not to spam history rows, so that the dropdown stays about participations not stages.  
19. As an operator, I want the whole Graph participation to remain one live map across stages, so that the panel is continuous mid-run.  
20. As an operator, I want Free and Graph to obey the same archive/view rules, so that I learn one model.  
21. As an operator, I want restart Graph to archive the previous map, so that a new Graph run is a new chapter.  
22. As an operator, I want restart Graph to require an explicit user action, so that it cannot happen silently.  
23. As an operator, I want interrupt or settle without seal not to create a junk history row, so that stop ≠ archive.  
24. As an operator, I want resume after park to restore the same live map, so that continuity holds (#277 / #283).  
25. As an operator, I want failed/blocked L1 with open L2 to refuse auto-seal, so that unfinished stage debt is not swept away.  
26. As an operator, I want dropdown labels to identify Free vs Graph and time or short title, so that I can pick the right revision.  
27. As an operator, I want done/total on the header to reflect the **viewed** revision, so that counts match what I see.  
28. As an operator, I want chrome to say when I am on history, so that I do not confuse it with live.  
29. As an Expert Agent author, I want clear tool errors on denied replace, so that I append or request permission instead.  
30. As an Expert Agent author, I want sealed→init to succeed without replace grant, so that post-completion planning is allowed.  
31. As an Expert Agent author, I want stage-local Graph todo rules unchanged, so that #281 tools still make sense.  
32. As a platform implementer, I want one revision list per Participant Session, so that Case multi-Session stays coherent.  
33. As a platform implementer, I want product-state projection to include revision metadata, so that FE is not inventing history.  
34. As a platform implementer, I want replace permission to remain platform-issued one-shot, so that agent flags alone cannot wipe.  
35. As a QA engineer, I want fixtures for E1–E6, so that the lifecycle cannot regress.  
36. As a QA engineer, I want fixtures for history view + live mutation isolation, so that read-only is enforced.  
37. As a QA engineer, I want fixtures that Graph stage advance does not mint revisions, so that dropdown spam cannot return.  
38. As a QA engineer, I want fixtures that open-item init without grant leaves state unchanged, so that #313 wipe ban holds.  
39. As a QA engineer, I want fixtures that granted replace archives prior snapshot, so that discard-on-replace cannot return.  
40. As an operator, I want multi-role Cases not to merge maps into one fake list, so that each Session’s map stays owned.  
41. As an operator, I want historical maps immutable, so that audit of past plans is trustworthy.  
42. As an operator, I want no keyword/NLP “replan detection” in platform code, so that AGENTS.md intent rules hold.  
43. As a reviewer, I want living docs cross-links to #313/#281/#277/#280, so that precedence stays clear.  
44. As an operator, I want empty live (brand-new Session) to show empty Tasks honestly, so that no phantom history appears.  
45. As an operator, I want selecting history never to resurrect that map as writable without an explicit product action (none in this Spec), so that archive stays freeze.

---

## Implementation Decisions

1. **Primary product seam (S1) — Task Map lifecycle:** Session-scoped **live map + revision list + seal/archive transitions** implementing E1–E6. Prefer extending the existing Free TodoStore / Graph plan projection pipeline rather than a third checklist kernel. Successful E3/E4/E2 archive must persist a **snapshot** sufficient to re-render Tasks (titles, statuses, owners/chips as already projected)—not a live alias to mutable state.  
2. **Secondary seam (S2) — Permission + envelope:** Reuse Spec #313 replace grant (`todo_replace_allowed` / structured `todo_replace_permission` / ChoiceCard `replace_todo_map`). Extend policy:  
   - open items + init without grant → reject, state unchanged;  
   - open items + grant → archive then init;  
   - sealed + init → archive then init **without** grant;  
   - empty live first init → create live, no archive.  
3. **Tertiary seam (S3) — UI projection:** Product-state / conversation snapshot exposes `task_map_revisions[]` (id, label, sealed_at / archived_at, work_mode Free|Graph, optional graph id, item counts) + `live_revision_id` + full snapshot payload for the viewed id. RightPanel Tasks header selector binds to this list; default view = live.  
4. **Graph participation = one map:** While a Graph Participant Session is active, L1/L2 plan_tree updates apply to the **same** live revision (E5). Do not emit a revision per stage completion.  
5. **Seal evaluation:** Run after todo mutations and after Graph stage settlement side-effects that terminalize L2. Predicate = all user-visible work items terminal; failed L1 with residual open L2 → not sealed.  
6. **E4 restart Graph:** Wire to existing explicit user Graph start/restart controls only; treat as authorized map switch (archive current). Do not infer restart from free text.  
7. **E6:** settle/interrupt/park must not call archive. Resume rehydrates the same live revision.  
8. **Historical view isolation:** FE selection state is view-only; WS/tool paths ignore “viewed revision” for writes. Optional: ignore stale client “edit history” attempts fail-closed.  
9. **Labels:** Prefer Agent-provided map title when present; else short derived label (work mode + time + done/total). No hardcoded vulnerability catalogs as titles.  
10. **Retention (v1 default):** Keep all revisions for the Case/Session lifetime unless a later ops Spec adds caps; if a cap is required for storage, drop oldest **archived** first and never drop live without archive.  
11. **Docs:** Amend #313 language from “replace discards” to “replace archives”; note Graph whole-participation map in task-graph / #281 “history row” sense.  
12. **No new intent NLP;** no multi-live Agent write targets; no resurrect-to-edit in v1.

### Lifecycle sketch (decision-rich)

```
live: active | sealed
revisions: [ ...archived snapshots, live ]

on todo maintain ops (append/start/done/drop/...):
  apply to live only
  if all_terminal(live): live.status = sealed   // E1

on todo.init / full map load:
  if live empty: install as live
  else if live.sealed: archive(live); install new live          // E2
  else if replace_grant: archive(live); install new live       // E3
  else: reject (state unchanged)

on explicit restart Graph (user):
  archive(live); install new live                              // E4

on stage advance / continue:
  mutate live only                                             // E5

on session settle/interrupt without seal:
  no archive                                                   // E6
```

---

## Testing Decisions

**Good tests** assert external behavior at S1–S3: revision list length/ids, seal flags, accept/reject of init, snapshot immutability after archive, UI projection fields, and that stage advance does not grow revision count—not internal helper names.

| Seam | Example external behaviors |
|------|----------------------------|
| **S1** | All-terminal → sealed, same revision id; sealed + init → revisions+1, new live; open + init no grant → error, revisions unchanged; open + grant → archive snapshot matches pre-init items including opens; stage complete × N → revision count unchanged; settle alone → revision count unchanged. |
| **S2** | Grant consumed after one successful replace; agent-only allow flag insufficient; sealed path does not require grant. |
| **S3** | Snapshot includes revisions + live id; selecting history does not change live id; live todo event updates live snapshot only. |

**Prior art:** Spec #313 Free todo replace tests; Node4 todo store / hard-graph plan merge tests; platform conversation snapshot / RightPanel Tasks projection tests; participant session park/resume.

**Fixtures:** Synthetic todo maps and Graph plan_tree envelopes; pure transition tests preferred over live LLM.

---

## Test seams (normative)

| ID | Seam | Role |
|----|------|------|
| **S1** | Task Map lifecycle (seal / archive / new live; E1–E6) | Primary |
| **S2** | Replace permission + init policy (extends #313) | Secondary |
| **S3** | Product-state revision list + RightPanel historical view | Tertiary |

Ideal: implementers hang behavior on these three seams only—no fourth policy kernel for “stage history.”

---

## Out of Scope

- Per-stage history rows in the Tasks dropdown.  
- Multi-live writable maps or Agent writing into historical revisions.  
- Resurrecting an archived map as live (fork/edit) without a future Spec.  
- Auto-seal from Agent prose or soft settle narrative alone.  
- Changing Finding Store, book-path L0, or package settlement honesty rules.  
- Making open todos a hard settlement gate (#313 L5 remains).  
- Default seat Expert Graph.  
- Intent detection via keyword/regex on user text.  
- Fixed product-authored next_steps option catalogs.  
- Mandatory retention GC / cross-Case global map browser.  
- Redesigning Graph L1 catalog or stage tool profiles.

---

## Further Notes

- **Why not only #313:** #313 stops silent wipe and empty-target continue; it does not require **archive** or **UI history**. Operators still experience “被覆盖” after legitimate replace.  
- **Why not per-stage archive:** Grill closed on whole participation as the history atom; stage-local L2 remains a **mutation** discipline (#281), not a revision list.  
- **Why sealed holds the panel:** Avoid empty flash between “all done” and “next plan”; E2 is the handoff.  
- **Incident class:** Same family as Case `68a83c02-…` (init wipe / lost orientation)—this Spec adds durable map memory after authorized chapter changes.
