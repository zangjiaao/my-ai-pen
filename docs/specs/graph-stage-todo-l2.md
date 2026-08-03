# Spec: Graph stage–scoped Todo (L2 checklist)

**Status:** implemented (Wave 1)  
**Issue:** [#281](https://github.com/zangjiaao/my-ai-pen/issues/281)  
**Related:** Spec #116 I0.21 (GraphStore L2 SoT); `docs/specs/task-graph.md` (L1 host / L2 Agent); Free OMP todo in `docs/specs/harness.md`

**Product path:** Expert Graph × Pi (Node4). Free work mode is unchanged except by explicit non-goals below.

---

## Problem Statement

Operators running **Expert Graph** see a confused Tasks panel:

1. Host correctly advances L1 stages (e.g. `init` done → `surface` **running**).
2. The Agent still uses Free-style **whole-engagement** `todo(init)` (recon / auth / vuln / exploit…).
3. Those items are merged under the **current** stage parent (often `graph-stage-init`), then `todo(done)` **auto-promotes** the next item to `in_progress`.
4. Result: **dual progress** — e.g. `graph-stage-surface` running **and** a “Web recon” L2 still **running under init**.

Users cannot tell whether the engagement is in surface, stuck in init, or both. Free mode’s full-map Todo is fine; Graph mode needs **stage-local** checklists only.

---

## Solution

**One product rule:**

| Mode | Todo meaning |
|------|----------------|
| **Free** | Whole-engagement phased map (unchanged) |
| **Graph** | **Only the current stage’s L2 checklist** under `graph-stage-{stageId}` |

Host **L1** stage status remains the sole authority for which stage is running. Agent Todo never invents a second L1 timeline.

Wave 1:

1. On Graph with an active `stageId`, reject **cross-stage / whole-engagement** `todo(init)` (actionable error) instead of silently stuffing a long map under the current stage.
2. All successful Graph todo mutations hang L2 only under the **current** stage parent (existing `setStageTodos` parent rewrite is the merge law).
3. On **stage end / stage start**, clear or archive **open/running L2** that must not stay “active” under a finished stage (no dual running L1+stale L2).
4. Auto-promotion after `todo(done)` must not create running L2 that belongs to a **future host stage** narrative (keep promotion **within** current stage items only; if none remain, leave no bogus running child).
5. Stage prompts / harness text: state that Graph Todo is **this stage only**, not a full engagement map.

---

## User Stories

1. As an operator on Graph, I want Tasks to show only one active stage at L1, so that I know where the runner is.
2. As an operator, I want L2 items under a done stage to stop showing as running when the host left that stage, so that the panel is not contradictory.
3. As an operator, I want L2 under `surface` only while surface is the current stage (or residual done history), so that recon work is not parked under `init`.
4. As an Agent on Graph, I want an error if I try to `todo(init)` a full multi-phase engagement map, so that I re-init for the current stage only.
5. As an Agent on Graph, I want `todo(init)` of a short stage checklist to succeed, so that I can track stage-local work.
6. As an Agent on Free, I want full phased `todo(init)` to keep working, so that Free OMP is unchanged.
7. As an operator on Free, I want no Graph-only restrictions on Todo, so that Free does not regress.
8. As a host Graph runner, I want stage transitions to own L1 status regardless of Agent todo completeness, so that gates stay host-driven.
9. As a host, I want stage switch to neutralize stale running L2 under the previous stage, so that dual-running cannot persist.
10. As an Agent, I want `todo(done)` within a stage to advance only remaining items of **that** stage, so that auto-promote does not invent next-stage work under the wrong parent.
11. As an operator, I want done L2 history under past stages to remain visible as done (optional), so that I can audit what was planned per stage.
12. As a subagent, I want private local todos not to replace Graph L1 on the panel, so that Main/Graph tree stays SoT (existing I0.21).
13. As a package worker, I want L2 package anchors to survive host merge rules already defined, so that Worker chips are not wiped incorrectly.
14. As a pack author, I want stage prompts to say “checklist for this stage only,” so that models are steered without hardcoding vuln lists.
15. As a reviewer, I want a single primary test seam at todo + Graph plan merge, so that AFK agents can verify the contract.
16. As an operator, I want surface stage running to mean host is in surface, not “agent marked recon in progress under init.”
17. As Node Runtime, I want Free path still emit TodoStore plan_tree; Graph path only Graph plan_tree, so that dual SoT does not return.
18. As an operator after `stage_end:init`, I want no `running` children under `graph-stage-init`, so that init looks closed.
19. As an Agent who only has one stage item left, I want `done` to leave zero running L2 until I add more, so that the tree is calm between actions.
20. As a product owner, I want this Spec not to change Free→Graph entry rules (#277/#278), so that mode authority stays separate.

---

## Implementation Decisions

### Vocabulary

- **L1:** Hard Graph stages (`graph-stage-{id}`), host-owned status pending|running|done|failed|blocked|skipped.
- **L2:** Work items under a stage; Agent Todo is a **facade** into GraphStore L2 on Expert Graph (I0.21).
- **Current stage:** `hardGraphRun.stageId` while a stage session is live.

### Free (non-goals for behavior change)

- Keep TodoStore → `plan_tree_updated` as Case Tasks SoT.
- Keep whole-engagement `todo(init)` and mid-run todo nudges.

### Graph — tool contract

1. When `hardGraphRun.plan` is active and `stageId` is set:
   - **`todo(init)`:** Accept only a checklist that is **stage-local**.  
     - **Reject** (error, not silent truncate) if the init payload encodes a **multi-phase whole-engagement map** (multiple phase names that clearly span future host stages, or an oversized multi-phase init that is not “this stage only”).  
     - Practical Wave1 rule: **at most one phase** on Graph init, **or** all phases must be aliases of the **current stage id/title** only; otherwise error with guidance to init only for the current stage.  
     - Prefer fail-closed over silent drop of extra phases (operator-visible honesty).
   - **`todo(append/start/done/…)`:** Apply to TodoStore then `setStageTodos(currentStageId, …)` only; never emit Free-style Todo-only plan_tree on Graph.
2. **Auto in_progress promotion** (single in_progress law in TodoStore): after `done`, only promote another item that remains in the **current stage’s** accepted checklist; do not leave running items that were only present because a rejected multi-phase map was partially applied (rejection avoids this).
3. Graph `todo(done)` keeps existing surface-ledger / package L2 gates.

### Graph — stage lifecycle

1. On **stage_end** (or immediately before **stage_start** of the next stage):
   - For the ending stage: any L2 still `running`/`in_progress` → set to **pending** or **skipped** with a host reason (Wave1 pick **pending** for unfinished, keep **done** as done). Must **not** remain `running` after L1 stage is `done`.
2. On **stage_start**: L1 stage = running; L2 for that stage starts empty or prior stage-local rows only (no carry of other stages’ open running rows onto this stage’s parent).
3. Parent rewrite remains: all L2 under stage get `parent_id = graph-stage-{stageId}`.

### Prompts / harness

- Stage user prompt / work.md guidance: Graph Todo = this stage checklist only; full engagement map is Free-mode behavior.
- Do not hardcode vulnerability category lists as required todos.

### UI

- No requirement to redesign Tasks chrome in Wave1 if SoT tree is honest; optional later: visually separate L1 vs L2.
- Do not reintroduce conversation-completed false-green of plan todos.

### Modules (conceptual)

- Todo tool Graph branch (init validation + emit path).
- HardGraphPlanStore stage todo merge + stage transition hooks in Graph runner/executor.
- TodoStore promotion behavior if it cross-cuts stages when multi-phase data wrongly entered (defense in depth).
- Stage prompt assembly for one-line checklist rule.
- Living docs: this file + pointer from `task-graph.md` L2 coverage SoT row.

---

## Testing Decisions

**Good tests:** assert **external plan_tree / tool results** after todo ops and stage transitions — not private map layouts beyond the public plan projection.

### Primary seam — todo tool + Graph plan merge (S1)

| Case | Expect |
|------|--------|
| Graph + stageId=init; `todo(init)` single-phase stage checklist | ok; L2 parents = `graph-stage-init` |
| Graph + stageId=init; `todo(init)` multi-phase map (init+recon+auth+vuln…) | **error**; plan L1 unchanged; no mass L2 under init |
| Free; multi-phase `todo(init)` | ok (regression) |
| Graph; `todo(done)` last init item | no running L2 under init inventing “next engagement phase”; open_count consistent |
| After mock `stage_end:init` + `stage_start:surface` | no running L2 under `graph-stage-init`; `graph-stage-surface` running |

### Secondary seam — stage transition (S2)

| Case | Expect |
|------|--------|
| setStageStatus(init,done) + neutralize open L2 | former running children not running |

**Prior art:** `hard-graph-plan` tests, `todo` tool tests, process-quality Graph plan tests, package L2 done gates.

---

## Out of Scope

- Free→Graph entry / Composer sticky / enter_graph permission UX (#277/#278).
- Changing L1 stage order or Feedback gates.
- Mid-run user_steer (already fixed).
- Finding booking / dual id.
- Login/CSRF skill improvements.
- Full UI redesign of Tasks panel.
- Hardcoding required todo labels per stage (answer-key style).
- Subagent private todo semantics beyond “do not broadcast.”

---

## Further Notes

- Incident class: conversation `f758d7f5-…` — host `stage_start:surface` while Agent L2 “Web侦察” remained running under `graph-stage-init` after whole-map `todo(init)`.
- Spec #116 already says Todo is a facade on Graph; this Spec **enforces stage-local scope** so the facade cannot smuggle a Free-style dual timeline.
- Wave1 prefers **reject bad init** over silent truncation so Agents get a clear retry signal.
- Implement after seams confirmation; label issue `ready-for-agent`.
- **Wave1 follow-up (code review on 9ebd851):** `phaseMatchesGraphStage` tightened from bidirectional `includes` to exact normalize equality **or** stage-slug + optional suffix only (`init-checklist`). Multi-phase weak substring hits (e.g. `minit`, mid-string stage fragments) no longer count as stage aliases. Single-phase free labels remain always stage-local. S1 seam tests cover createTodoTool + HardGraphPlanStore (ok / reject / Free regression / neutralize). Harness + `experts/pentest/work.md` document Graph stage-only checklist (no vuln answer keys).
