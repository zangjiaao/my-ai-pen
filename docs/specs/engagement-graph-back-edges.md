# Spec: Constrained Engagement Graph (declarative back-edges) + `hypothesis_cycle`

**Status:** Implementable Spec  
**Issue:** [#285](https://github.com/zangjiaao/my-ai-pen/issues/285)  
**Grilling:** owner session 2026-08-04 — “坚持图的概念，让 Graph 转起来”  
**Field inputs:** `1a13fbd1-…` (linear `app_assessment` long run, weak Black-cat process fidelity); Graph-vs-pipeline naming gap  
**Depends on:** ADR 0001 Graph × Pi; Spec #277 Session; Spec #278 catalog/dual-rail; Spec #274/`hypothesis-evidence.md` queue; Spec #284 composer Graph bind  
**Product path:** Graph × Pi + Node4. Soft Graph retired.  
**Does not reintroduce:** LLM-invented stage edges; Soft scenario Graph; agent markdown tracker as gate SOT; answer keys in agent input.

---

## 1. Purpose

Today’s Task-layer Hard Graph is **ordered stages** (`hard order, cannot skip`) — a **pipeline with retries**, not a graph that can **turn** (legal back-edges). Operators and the product name (“Graph”) expect **constrained cycles** like industry orchestrators (LangGraph conditional edges / ADK routes): host-owned topology, structured routing, bounded loops.

This Spec defines:

1. **Runner capability:** declarative edges + deterministic route over Product-state projection + hop budgets + soft landing.  
2. **New product Graph `hypothesis_cycle`:** Black-cat-inspired process (hypothesis-first cycles) **without** copying full Black-cat SM names as platform vocabulary or using `engagement-tracker.md` as gate SOT.  
3. **Wave1 comparison protocol:** freeze `app_assessment` topology; dual-target lab (DVWA + Juice); offline **D0–D3 difficulty × R0–R3 evidence reliability** scorecard.

---

## 2. Product law

| ID | Law |
|----|-----|
| **G1** | **Host owns topology.** Edges and legal successors are declared in the Graph definition. Main/Agent **never invents** edges or free `goto`. |
| **G2** | **Route is deterministic.** After a node settles, runner evaluates `route(projection) → key → next` where `next ∈ declared_successors[current]`. No NLP of chat for routing. |
| **G3** | **A+B routing.** Default: pure host predicates. Optional **Gate**: Main submits `choice_key` from a **whitelist** declared on the node (industry: path_map key / ADK `REFINE\|DONE`). Wave1 Gate is **Agent-only** (no HITL). |
| **G4** | **Budgets (industry C).** Global hop cap (default **25** node entries) + per hot back-edge cap (default **≤3**). Stage `max_retries` remains **separate** (same-node attempt). Exhaustion is a **hard pre-route check**: only `hop_exhausted` edges may fire (else soft-land to `book`/blocked) — work edges must not continue the cycle. Soft landing prefers `book` if bookable work exists; else blocked + booking-tail/close-out pattern. Not a bare process crash as UX. |
| **G5** | **Two-layer fan-out.** Task-layer edges only between coarse nodes; **packages/subagents stay inside nodes** (industry Send/Parallel workers). Do not explode Task graph into per-vuln-class nodes in Wave1. |
| **G6** | **State projection.** Route inputs are a **small typed projection** of Product state (surfaces, hypothesis queue summary, store feedback/booked, gate outcomes, hop counters, pending choice). Runner-owned counters. Optional `route-checkpoint` file is **audit only**, not SOT. |
| **G7** | **Wave1 dual graphs.** `app_assessment` **frozen** (no topology/process change). New `hypothesis_cycle` uses full edge table. Wave2 may add **conservative** back-edges to assessment. |
| **G8** | **Catalog.** `hypothesis_cycle` is a **product L1** Graph (not `*_thin`). `when_to_use` contrasts with assessment. |
| **G9** | **Booking boundary unchanged.** Hypothesis `confirmed` ≠ ledger book. Sole book path remains Store → L0 → `finding(confirm)`. |
| **G10** | **Evaluation.** Compare arms by **difficulty D0–D3** and **evidence reliability R0–R3**, not finding count or stage-all-green. Offline human scorecard; no answer keys in agent-facing input. |

---

## 3. Vocabulary

| Term | Definition |
|------|------------|
| **Engagement Graph** | Task-layer Graph whose transitions are a **declared edge set** (may include back-edges), not only `stages[]` array order. |
| **Node** | Coarse work unit (maps to today’s stage session + settlement). |
| **Edge** | Declared `(from, when_predicate_id, to, priority?, gate?)`. |
| **Route key** | Structured label for a successor (path_map key). |
| **Hop** | One **entry** into a node (counts toward global cap). |
| **Soft landing** | Budget/exit path into `book` or blocked+close-out without silent Free demotion. |
| **`hypothesis_cycle`** | Product Graph id for the Wave1 cyclic / hypothesis-first arm. |

_Avoid:_ calling linear Hard order alone “full graph semantics”; equating this Spec with shipping Google ADK Python as product Node (ADR 0001).

---

## 4. Seams (test high)

Prefer **one pure primary seam** + thin adapters.

| Seam | Behavior |
|------|----------|
| **S1 Route pure function (primary)** | Input: projection + current node id + graph edge table + hop/back-edge counters + optional `choice_key`. Output: `{ next, key, reason }` or fail-closed. Priority: first matching edge by priority (if/elif). Unmatched → fail-closed (no silent `i++`). |
| **S2 Edge table load** | Graph JSON (or equivalent pack definition) loads nodes + edges + predicate whitelist; unknown predicate id → **load fail**. |
| **S3 Runner loop** | Replace sole “hard order for-loop” when graph declares edges: settle node → route → enter next until END/book terminal/hop exhaust. Linear graphs without edges remain backward-compatible ordered stages. |
| **S4 Projection builder** | Build route projection from Product state only (hypothesis counts, surfaces, store, gate, counters). |
| **S5 `hypothesis_cycle` definition** | Pack graph file + L1 catalog fields + stage tools/hypothesis_work_mode as needed. |
| **S6 Lab scorecard (offline)** | Protocol doc/template: dual target, dual arm, D/R rubric — not runtime agent tools. |

Primary pure unit seam: **S1**. Integration: runner with fixture graph exercising one back-edge + hop exhaust → book.

---

## 5. Wave plan

| Wave | Scope |
|------|--------|
| **Wave1** | S1–S5: edge runner + `hypothesis_cycle` + L1 catalog; **app_assessment frozen**; dual-lab D/R scorecard protocol; Agent Gate choice only |
| **Wave2** | Conservative back-edges on `app_assessment`; optional HITL Gate; richer predicates |
| **Out of Spec DoD** | Full Black-cat technique encyclopedia parity; Soft Graph; ADK product kernel |

---

## 6. `hypothesis_cycle` nodes (Wave1)

| id | Role (Black-cat spirit, product names) |
|----|----------------------------------------|
| `init` | Scope / RoE / budget awareness (IDLE-like) |
| `recon` | Attack surface growth |
| `enumerate` | Active hypotheses (signal, prove_if, disprove_if) |
| `validate` | Independent evidence; commit confirmed\|killed\|deferred |
| `exploit_lite` | Application-layer PoC only; **no postex** |
| `book` | Store → confirm; REPORT-like close |

`roe.allow_postex: false` for this Graph.

### 6.1 Minimal edge table (Wave1)

Priority high→low within each `from` (LangGraph-style single path_fn):

| from | when | to |
|------|------|-----|
| init | `stage_pass` | recon |
| recon | `active_hyp_ge_1` OR `surfaces_ge_1` | enumerate |
| recon | `hop_exhausted` | book |
| enumerate | `active_hyp_ge_2_complete` | validate |
| enumerate | `active_eq_0_and_open_surface` | recon |
| enumerate | `active_hyp_incomplete` (Wave1: active≥1 and complete&lt;2) | enumerate |
| enumerate | `hop_exhausted` | book |
| validate | `has_confirmed_unexploited` | exploit_lite |
| validate | `need_more_signal` | enumerate |
| validate | `hop_exhausted` | book |
| validate | `main_choice:to_enumerate` \| `to_exploit_lite` \| `to_book` | (declared targets) |
| exploit_lite | `stage_pass` OR `has_store_candidates` | book |
| exploit_lite | `exploit_failed_retry_validate` | validate |
| book | terminal | END |

Predicate ids are **whitelist only** (implementation maps id → pure check on projection). Exact boolean definitions live with S1 tests.

Gate: only where multiple legitimate strategies exist (validate); Main sets `choice_key` via structured tool; host validates membership.

### 6.2 Budgets (defaults)

| Knob | Default |
|------|---------|
| Global hop | 25 |
| Hot back-edges (`enumerate→recon`, `validate→enumerate`, `exploit_lite→validate`) | ≤3 each |
| Stage max_retries | Existing per-node attempt (independent) |

---

## 7. Comparison protocol (Wave1)

### 7.1 Arms

| Arm | Graph id | Notes |
|-----|----------|--------|
| Baseline | `app_assessment` | **Frozen** Wave1 |
| Experiment | `hypothesis_cycle` | Edges + hypothesis process |

Same Expert pack, same model env, same RoE, independent clean targets.

### 7.2 Targets

**DVWA + Juice Shop** (two clean instances per arm or full reset; record URLs).

### 7.3 Primary KPIs

**Difficulty (per finding or expected class, offline):**

| Tier | Meaning (web lab) |
|------|-------------------|
| D0 | Shallow: listing, phpinfo, default banners, trivial exposure |
| D1 | Standard module vulns with single-module proof |
| D2 | Needs session / dual-actor / level / IDOR conditions |
| D3 | Multi-step / non-menu / chain-like |

**Evidence reliability (per booked finding, offline):**

| Tier | Meaning |
|------|---------|
| R0 | Missing/mismatched proof |
| R1 | Fragment only; not independently reproducible |
| R2 | Reproducible steps + output; impact weak/unclear |
| R3 | Observation + reproduction + impact clear |

**Headlines:** count of **(D1+ ∩ R2+)**; **D0 share** among booked (lower better).  
**Not primary:** raw finding count; all stages green.

### 7.4 Secondary

Hop/back-edge counts; hop_exhausted; hypothesis status histogram; tokens/wall-clock; terminal honesty.

### 7.5 Agent input ban

No scorecard text, expected vulnerability lists, write-ups, or official walkthroughs in agent-facing prompts (same class as hard-vs-node5 protocol).

---

## 8. Acceptance bars

| # | Bar |
|---|-----|
| **E1** | Pure route tests: fixture edge table + projection → correct next; unknown predicate fails load; unmatched route fail-closed |
| **E2** | Back-edge: e.g. enumerate with `active_eq_0_and_open_surface` → recon; counter increments; cap blocks further same edge |
| **E3** | Global hop exhaust → soft landing toward book/blocked path (no infinite loop) |
| **E4** | Linear graph without edges still runs ordered stages (compat) |
| **E5** | `hypothesis_cycle` in product L1 catalog; composer can select; #284 bind still forces Hard |
| **E6** | Gate: invalid `choice_key` rejected; valid key selects declared edge |
| **E7** | Packages still only inside nodes; no requirement to Task-node every class |
| **E8** | Scorecard template exists for DVWA+Juice dual-arm D/R offline fill |
| **E9** | Docs: this Spec + `docs/README.md` index; cross-link task-graph / hypothesis-evidence |

---

## 9. Out of scope

- Replacing product Node with Google ADK Python process  
- Soft scenario Graph / LLM free stage scheduler  
- Wave1 changes to `app_assessment` topology or process  
- Wave1 HITL Gate (human choice)  
- Full Black-cat `techniques/*.md` import as gate SOT  
- Auto-scoring D/R without human scorecard  
- Postex / lateral on `hypothesis_cycle`  

---

## 10. Implementation notes (agents)

1. Prefer extending Hard Graph runner with **optional edges mode** over a second product kernel.  
2. Keep Main ≠ stage scheduler: Main may only emit **whitelist choice_key** or mutate Product state (hypothesis/surfaces/findings).  
3. Align naming: document “ordered stage harness” vs “engagement graph with edges” in task-graph.md when implementing.  
4. Hypothesis queue remains Spec #274; this Spec **binds routing** to queue/surface projections.  
5. Industry references (non-normative): LangGraph conditional edges + recursion_limit; ADK routes + max_iterations + escalate/DONE.

---

## 11. Doc maintenance

Update this file when edge predicates, budgets, or Wave2 assessment back-edges change. Index in `docs/README.md`.

### Implementation map (Wave1)

| Seam | Location |
|------|----------|
| S1 route pure | `node4/src/runtime/engagement-graph-route.ts` (+ `.test.ts`) |
| S2 load / edges | `hard-graph-definition.ts` `loadHardGraphFile` / `normalizeHardGraphDefinition` |
| S3 runner loop | `hard-graph-runner.ts` optional edges mode (`graphHasEngagementEdges`) |
| S4 projection | `buildRouteProjection` + stage `routeProjection` / `routeChoiceKey` |
| S5 product graph | `experts/pentest/graphs/hard/hypothesis_cycle.json` + L1 catalog |
| S6 scorecard | `docs/specs/lab-scorecard-hypothesis-cycle.md` |
| Runner integration tests | `node4/src/runtime/engagement-graph-runner.test.ts` |

Naming: **ordered stage harness** vs **engagement graph with edges** — see `docs/specs/task-graph.md`. Hypothesis queue remains Spec #274; this Spec binds routing to queue/surface projections.
