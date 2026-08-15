# Spec: Session owns runtime — Task is dispatch package only

**Status:** Implementable Spec (product contract)  
**Tracker:** [#354](https://github.com/zangjiaao/my-ai-pen/issues/354)  
**Decision source:** Product grill (Case `6eb54137-…` LLM stream fail → dispose + cold continue → fake replan; operator demand to abolish Task-as-Case lifecycle; collab-section Session management).

**Product path:** Node4 Graph × Pi + platform conversation UI (ADR 0001).

**Amends:**  
- `docs/specs/participant-session.md` / Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) — D9 same-mode continue must retain **working runtime**, not only work_mode on the wire.  
- `docs/specs/participant-session.md` / Spec [#283](https://github.com/zangjiaao/my-ai-pen/issues/283) I0.9 — park/attach extended: LLM turn failure and user Task interrupt **retain** captain; dispose whitelist narrowed.  
- `docs/specs/task-map-history.md` / Spec [#321](https://github.com/zangjiaao/my-ai-pen/issues/321) — **operator RightPanel revision selector retired**; incomplete map value path = **handoff to Session**, not browse-only history; v1 reset/delete Todo rules below.  
- Case status presentation — latest Task package light ≠ Case death.

**Adjacent (do not merge):**  
- Spec [#353](https://github.com/zangjiaao/my-ai-pen/issues/353) — LLM stream liveness / incomplete finish_reason observability.  
- Spec [#350](https://github.com/zangjiaao/my-ai-pen/issues/350) — tool-name-known tool cards.  
- Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313) — Free silent init wipe ban (still holds on live map).  
- Spec [#455](https://github.com/zangjiaao/my-ai-pen/issues/455) / [`session-dialogue-path.md`](session-dialogue-path.md) — Session-first dialogue: continue turn text = operator utterance (no engagement-book rewrap).

**Does not amend:** Finding Store / book-path L0, intent NLP ban, Default seat never-Graph, subagent package idle TTL (package-level, not Participant Session).

---

## Problem Statement

Operators experience **Session amnesia** after ordinary failures:

1. A model stream fails mid-work (`Stream ended without finish_reason`).  
2. The product treats that as **Task terminal + dispose captain runtime** (pi session + Todo).  
3. User says「继续」; platform starts a **new task_assign** with an **empty TodoStore**.  
4. Agent **todo.init**s a new plan — feels like **Session reopened**, context and checklist continuity lost.

Root confusion: **Task** (a short dispatch package) was used as if it owned **Case/Session lifecycle**. A Case runs many packages; a Participant Session is long-lived. Collapsing them caused repeated cold reseeds, fake replans, and useless “history browse” that cannot continue work.

---

## Solution

### Hierarchy (normative)

```
Case (conversation_id / CaseID)
  └── Participant Session × N  (default key: case + expert_id)
        ├── captain pi runtime + live Todo map
        ├── Task packages (dispatch envelopes) — status for lights only
        └── Sub packages (short-lived workers)
```

| Concept | Owns | Does **not** own |
|---------|------|------------------|
| **Case** | Shared thread, Findings, evidence, scope; status **light** = latest Task package situation | Single Task lifecycle as Case death |
| **Participant Session** | Work identity, captain pi, live Todo, work mode | Disposed on every Task error |
| **Task** (name kept) | One platform→Node work package: start → run → complete/error **for display** | Dispose pi; mark Case dead; force cold reseed |
| **Sub** | Package worker; collab **end** only | Participant Session semantics / Reset |

### Lifecycle locks

| # | Lock |
|---|------|
| L1 | Session dispose **only**: Case delete/archive (all Sessions under Case), or user **manual Session delete** in collab UI. |
| L2 | **No** idle reclaim of Participant Session / captain for product reasons (retire 30m park TTL as Session death). Subagent package idle TTL may remain. |
| L3 | Expert switch does **not** dispose the other expert’s Session. |
| L4 | Task complete/error, user Task interrupt, LLM turn failure → **do not** dispose Session/pi/Todo. |
| L5 | User interrupt = **pause this Task package** (yellow light), not close pi Session. |
| L6 | LLM turn failure = Session-local error event; Case stays workable; next user message / continue attaches **same** Session. |
| L7 | Case light: green idle / blue running / yellow wait-or-paused / red latest error — **display only**; red ≠ Case dead. |
| L8 | Same-expert new Session after delete → **auto-handoff** incomplete Tasks from Case holding (strict expert isolation). |
| L9 | Session **Reset** = clear model/pi working memory, **keep** incomplete Todo. |
| L10 | Session **Delete** = dispose identity; incomplete Tasks → Case **pending handoff** holding (not fuzzy browse history). |
| L10a | **pi-agent-core instance lifecycle:** Delete = dispose Agent + drop park; Reset = dispose Agent + mint new `Agent.sessionId` and reseed (pi `/new` style) while keeping incomplete Todo. Collab copy chrome shows **only** `Agent.sessionId` (Node-projected); never expert catalog id. Expert catalog id remains the roster/park key only (case + expert_id). **Host layout** (not Product SOT): `workspace/case-{caseId}/expert-{expertId}/pi-{sessionId}/` — `session.jsonl` + events; park continue reuses the dir; Reset opens a new `pi-*`. |
| L11 | Operator RightPanel **Task Map revision selector retired** (#321 S3 UI). Process records may remain for **audit only**. |
| L12 | Collab UI lives in RightPanel **case-collab-section**; Session cards: Delete + Reset (confirm dialogs); Sub: End only. |

### #321 History FE handling (explicit)

| Was (#321) | Now |
|------------|-----|
| Operator dropdown to inspect archived maps | **Remove / do not ship as workbench UX** |
| Archive-then-switch for authorized replan | May remain as **internal/audit** process record where still needed |
| Value of past progress | **Handoff incomplete map to new Session** (same expert), not read-only browsing |

**Yes: amend #321** living doc + issue comment — S3 operator history view **superseded** by this Spec; S1 seal/E2/E3 backend rules stay until handoff/replan paths restate them. Do **not** leave two conflicting operator requirements.

---

## User Stories

1. As an operator, I want a Case to survive many Task packages, so that one failure does not kill the whole engagement.  
2. As an operator, I want Session to keep working memory across LLM errors, so that「继续」does not amnesiac replan.  
3. As an operator, I want Task complete/error to update a status light only, so that I know latest package state without Case death.  
4. As an operator, I want red light to mean “an error occurred,” not “Case is failed forever,” so that I can still message the Session.  
5. As an operator, I want user interrupt to pause the Task package while keeping pi Session, so that stop is not Session teardown.  
6. As an operator, I want yellow light for authorize wait and Task pause, so that I learn four colors only.  
7. As an operator, I want green when idle and blue when a Task package is running, so that liveness is scannable.  
8. As an operator, I want Session management in the collab section, so that experts-as-Sessions are visible.  
9. As an operator, I want Delete Session with confirm, so that I can end a Session deliberately.  
10. As an operator, I want Reset Session with confirm, so that I can clear model context without losing the incomplete Todo list.  
11. As an operator, I want incomplete Tasks held after Delete, so that they are not silently lost.  
12. As an operator, I want a light collab hint for pending handoff, so that I know progress will resume when I re-use the expert.  
13. As an operator, I want auto-handoff when the same expert opens a new Session, so that valuable progress continues.  
14. As an operator, I want handoff strictly expert-scoped, so that expert Y never receives expert X’s checklist.  
15. As an operator, I do not want a Tasks history dropdown for day-to-day work, so that the panel stays simple.  
16. As an auditor, I want process records available offline/backend if needed, so that compliance is possible without workbench clutter.  
17. As an operator, I want Sub cards to show status and End only, so that runaway workers can be killed without Session ceremony.  
18. As an operator, I want Case delete to release all Node captains for that Case, so that memory does not leak.  
19. As an operator, I want Case ID visible in product chrome eventually, so that Cases are addressable.  
20. As a platform implementer, I want Node to resolve pi by SessionID, so that dispatch does not create a new captain per Task error.  
21. As a platform implementer, I want Task package id optional for logging only, so that lifecycle is not driven by package id.  
22. As a QA engineer, I want fixtures: LLM error → same Session Todo intact after continue.  
23. As a QA engineer, I want fixtures: interrupt Task → Session retained → next message attaches.  
24. As a QA engineer, I want fixtures: Delete Session → pending hold → same expert re-entry handoff.  
25. As a QA engineer, I want fixtures: Reset keeps open todos, clears need for cold init.  
26. As a QA engineer, I want fixtures: Case delete notifies Node release.  
27. As a QA engineer, I want no FE history selector regression as product requirement.  
28. As a reviewer, I want #321 amended so S3 UI is not still “must implement.”  
29. As an Expert Agent author, I want continue after stream error to see prior open todos, so that I append instead of init.  
30. As an operator, I want default one Session per expert per Case, so that multi-instance same expert stays rare.  
31. As an operator, I want explicit second Session only if product later exposes it, so that ideal is still one-per-expert.  
32. As a Node Runtime owner, I want dispose whitelist enforced in one captain end policy, so that decideParkOnEnd no longer treats all non-abort as product_terminal dispose.  
33. As an operator, I want metering ledgers independent of Session reset/delete, so that #323 holds.  
34. As a developer, I want no NLP to invent Session end from free text.  
35. As an operator, I want switching expert to leave the prior expert Session intact, so that I can return without amnesia.

---

## Implementation Decisions

1. **Primary seam (S1) — Session runtime ownership:** Captain pi + live Todo keyed by SessionID; Task package start/end must not dispose captain. Replace `decideParkOnEnd({ aborted: !cancel })` product_terminal-for-all-non-abort with explicit whitelist (Case close, Session delete, optional future manual end only).  
2. **Secondary seam (S2) — Task package status projection:** complete/error/running/paused update **latest package light** and package records; conversation status light follows latest package without meaning Case death.  
3. **Tertiary seam (S3) — Collab Session management UI:** case-collab-section cards: select current Session, Delete, Reset (dialogs); Sub: End only; pending-handoff badge.  
4. **Quaternary seam (S4) — Incomplete Todo handoff:** Case holding store per expert; on same-expert Session create, auto-apply open map to new captain; strict isolation.  
5. **Case close protocol:** structured Node message on Case delete/archive → release all captains for CaseID.  
6. **Continue after package error:** attach existing Session; do not require empty Todo first init.  
7. **#321 amendment:** remove operator requirement for revision dropdown; keep audit-oriented retention optional; handoff supersedes browse.  
8. **Naming:** keep “Task” for dispatch package; product docs forbid “Case failed” for package error.  
9. **Park TTL:** do not use 30m park expiry as product Session death; reseed only with honest messaging if process died.  
10. **Phases:** P0 S1+S2; P1 S3+S4; P2 Case close sync + CaseID chrome; P3 optional multi-Session per expert UI.

### Test seams (normative)

| ID | Seam | Role |
|----|------|------|
| **S1** | Session runtime retain/dispose whitelist | Primary |
| **S2** | Task package status light (non-terminal Case) | Secondary |
| **S3** | Collab Delete/Reset/Sub End | Tertiary |
| **S4** | Pending hold + same-expert auto-handoff | Quaternary |

---

## Testing Decisions

**Good tests** assert external behavior: after LLM-class error, continue sees same open todos; interrupt retains Session; package error sets red light but next message works; Delete holds map; new Session same expert receives hold; Reset keeps todos; Case delete releases Node; FE has no required history selector.

**Prior art:** #283 park attach tests; #277 work envelope; #313 free init replace; #321 task-map pure tests (retain where still valid for seal/E2).

**Fixtures:** synthetic LlmTurnError path; pure handoff holding; no live LLM required for S1/S4.

---

## Out of Scope

- Full rename of all wire fields off `task_*` strings (may keep names; semantics change is mandatory).  
- Operator Task Map history dropdown polish (retired).  
- Cross-expert auto-handoff.  
- Subagent package idle TTL redesign (keep package-level).  
- Finding Store / book-path changes.  
- #353 stream stall implementation (adjacent).  
- Intent NLP for Session end.

---

## Further Notes

- **History FE:** **Amend #321** — S3 operator revision select **out of product**; implementers should **remove or hide** `TasksMapHeader` revision UI when shipping this Spec, not leave dual requirements.  
- **Why handoff > history browse:** operator value is continuing unfinished work, not museum mode without ownership.  
- **Incident class:** `6eb54137-…` cold continue after stream fail.  
- **Living doc index:** link from `docs/README.md`.
