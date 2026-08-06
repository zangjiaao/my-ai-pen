# Spec: Engagement Graph JSON boundary (topology data-plane vs code standards)

**Status:** Implementable Spec (contract-first)  
**Issue:** [#286](https://github.com/zangjiaao/my-ai-pen/issues/286)  
**Grilling:** owner session 2026-08-05/06 — “JSON 控频繁打磨；代码控固定标准”  
**Depends on:** ADR 0001 Graph × Pi Node4; Spec #285 Engagement Graph back-edges; Spec #278 catalog/dual-rail; Spec #284 composer Graph bind; Spec #274 hypothesis-evidence  
**Product path:** Graph × Pi + Node4. Soft Graph retired. No ADK product kernel.  
**Does not reintroduce:** LLM-invented edges; Soft scenario Graph; arbitrary edge scripts/DSL; ADK Dynamic-as-product-main-path.

---

## 1. Purpose

Operators and pack authors need a **clear split**:

| Plane | Owns | Change cadence |
|-------|------|----------------|
| **JSON (data plane)** | Graph **shape**: stages, edges, hop/back-edge budgets, RoE flags, catalog copy | Frequent process tuning |
| **Code (standards plane)** | **Interpreter**, **predicate semantics**, **route projection**, **settlement / booking**, product invariants | Domain capability / product law |

Today #285 already implements optional `edges` + pure route. This Spec **codifies the boundary** so future work knows: grind process → edit pack Graph JSON; grind domain → code + predicate registry. It is **not** a general workflow engine (no “everything in JSON”).

Industry note (non-normative): ADK **graph-based** workflows ≈ static declared structure; ADK **Dynamic** workflows put control flow in code (`while` / `run_node`). Product choice here is **declarative constrained graph** (JSON topology + host pure route), **not** ADK Dynamic as the product main path.

---

## 2. Product law

| ID | Law |
|----|-----|
| **J1** | **Topology is data.** Stage ids, edge table, priorities, gate choice keys, and route budgets live in pack Graph JSON (or equivalent pack definition). |
| **J2** | **Semantics are code.** Predicate evaluation, projection field meanings, hop soft-land *policy*, settlement honesty, and booking gates are implemented in Node4 — not pack scripts. |
| **J3** | **Unknown `when` fails load.** Edge `when` must be in the closed predicate whitelist. Unknown id → Graph load fail (fail-closed). |
| **J4** | **No edge DSL / scripts.** JSON must not embed arbitrary expressions, JS, or free-form condition languages. |
| **J5** | **Route inputs are typed projection only.** `route(projection, edges, counters) → next` is pure; no NLP of chat for routing (align #285 G2). |
| **J6** | **Soft-land policy is fixed.** Budgets may be overridden in JSON; hop-exhaust ordering and prefer-book soft-land behavior stay host product law (align #285 G4). |
| **J7** | **Product Graph onboarding is dual-rail explicit.** Pack file existence is necessary but not sufficient: L1 / platform product template / composer list must register the id (align #278 / #284). |
| **J8** | **Linear remains first-class.** Graphs without `edges` keep ordered stage harness (e.g. frozen `app_assessment` Wave1 topology). |
| **J9** | **One L1 Graph per engagement capability** as the default product grain (web / internal / recon…), not one mega-graph and not “skills only, zero graphs.” Report/weapon libraries are shared adapters — not edge table content. |
| **J10** | **Grind process ≠ grind quality alone.** JSON edge tuning does not replace evidence/booking integrity or hypothesis falsification discipline. |

---

## 3. Vocabulary

| Term | Definition |
|------|------------|
| **Graph JSON** | Pack definition file under expert hard graphs (stages + optional edges + budgets + metadata). |
| **Data plane** | Fields pack authors may edit without changing the route interpreter. |
| **Standards plane** | Code-owned interpreter, predicate registry, projection builder, settlement, booking. |
| **Predicate whitelist** | Closed set of `when` ids; each maps to a pure check on `RouteProjection`. |
| **Route projection** | Small typed Product-state view consumed only by route (not full chat/session dump). |
| **Explicit registration** | Product catalog / platform / UI must list a Graph id before operators can select it as L1. |
| **Capability Graph** | Product L1 Graph scoped to one engagement capability (e.g. web assessment, internal lateral under strict RoE). |

_Avoid:_ “Dynamic ADK workflow” as product Graph; Soft Graph; treating Free mode as a Graph JSON file.

---

## 4. JSON allow-list (data plane)

Pack Graph JSON **may** declare:

| Area | Fields (conceptual) |
|------|---------------------|
| Identity / catalog copy | `id`, `label`, `short_label`, `when_to_use`, `description`, `discipline` |
| RoE flags (declared) | e.g. `roe.allow_postex` — **enforcement** remains code |
| Stages | `id`, `intent`, `success`, `require`, `tools`, `max_retries` (and existing pack stage fields already supported by load) |
| Edges | `from`, `when`, `to`, `priority?`, `choice_key?`, `hot_back_edge?` |
| Budgets | `route_budgets.global_hop`, `route_budgets.back_edge_caps` |

**Forbidden in JSON:**

- Arbitrary condition expressions / scripts / embedded code  
- New `when` strings not on the code whitelist  
- Projection formulas or field remaps  
- Overrides of soft-land *policy* (prefer-book order, hop-before-invalid-choice)  
- Booking gate rules, honesty rules, or Free/Graph intent invent  

**Optional `schema_version`:** not required for this Spec. Document that current contract matches #285 implementation; introduce version field only on a future breaking change.

---

## 5. Code standards plane

| Component | Responsibility |
|-----------|----------------|
| **Load / validate** | Parse stages + edges; reject unknown `when`, bad endpoints, malformed budgets |
| **Predicate registry** | Closed id list + pure evaluators on projection |
| **Route pure function** | Deterministic next node or fail-closed; hop precheck; hot back-edge caps |
| **Projection builder** | Fill fixed `RouteProjection` from Product state + stage structured deposits |
| **Runner loop** | Linear mode if no edges; edge mode settle → route → next if edges present |
| **Settlement / booking** | Honesty, package settle, confirm≠book, L0 ledger path |
| **Catalog / bind** | Product L1 resolution; composer Graph → Hard bind (#284) |

---

## 6. Seams (test high)

Prefer **one pure primary seam** + thin docs/checklist.

| Seam | Behavior |
|------|----------|
| **S1 Load / edge-table validate (primary for this Spec)** | Graph JSON with stages + edges → accept only allow-listed shape; unknown `when` → fail; edge endpoints must be stage ids; empty edges / omitted edges → linear mode OK |
| **S2 Predicate registry contract** | Documented whitelist equals runtime ids; adding a predicate requires code + unit tests (process note for agents/humans) |
| **S3 Route pure (owned by #285)** | Unchanged primary runtime seam: projection + edges → next; budgets from JSON merge with code defaults |
| **S4 Registration checklist (docs + optional thin test)** | Product Graph requires pack file **and** dual-rail entries; Spec documents checklist — full multi-repo auto-register is out of scope |

Primary pure unit seam for **this** Spec: **S1** (boundary enforcement at load). Runtime behavior continues to rely on #285 S1 route.

---

## 7. Capability Graph grain (product)

Default: **one product L1 Graph per engagement capability** (web / internal / recon-osint / …).

- Shared: expert pack tools, reporting pipeline, finding ledger, RoE **enforcement**.  
- Not Graph topology: 0day corpus, report writing engines, Free-mode freestyle.  
- Phishing / postex-class capabilities: structure may be declared in JSON; **allow and execution** stay code/RoE fail-closed.  
- “全能卷王” personas map to **multiple Graphs + packs**, not one unbounded JSON mega-graph.

---

## 8. Operator / author SOP

### Grind process (prefer JSON)

1. Edit pack Graph `stages` / `edges` / `route_budgets`.  
2. Use only whitelisted `when` ids.  
3. Load graph in unit/load tests; run targeted engagement tests if touching product ids.  
4. No catalog change if id already registered.

### Grind domain (require code)

1. New predicate id → registry + pure eval + tests + Spec predicate table.  
2. New projection field → type + builder + tests + docs.  
3. Booking / honesty / RoE behavior → product code + living Specs.  
4. New product Graph id → pack JSON **plus** explicit dual-rail registration.

---

## 9. Acceptance bars

| # | Bar |
|---|-----|
| **B1** | Living Spec documents JSON allow-list, forbidden list, and code standards plane (this file) |
| **B2** | Indexed from `docs/README.md`; cross-linked from `engagement-graph-back-edges.md` |
| **B3** | Load path rejects unknown edge `when` (existing #285 behavior; tests remain green) |
| **B4** | Graphs without edges still linear-compatible |
| **B5** | Explicit statement: no ADK Dynamic product main path; no Soft Graph |
| **B6** | Product Graph registration checklist documented (pack + L1/platform/composer) |
| **B7** | Capability grain (one L1 per engagement capability) documented |

**Contract-first (grilling D8):** No large runner refactor required. Small doc/test alignment only if drift is found.

---

## 10. Out of scope

- ADK Python/Go as product Node process  
- Soft scenario Graph / free LLM stage scheduler  
- JSON condition DSL or pack-authored scripts on edges  
- Auto-discover all `graphs/hard/*.json` into product L1 without registration  
- Auto D/R scoring; answer keys in agent prompts  
- Implementing every future capability Graph (web/internal/recon) in this Spec  
- Replacing Free mode with Graph JSON  

---

## 11. Implementation notes (agents)

1. Prefer documenting and lightly enforcing the **existing** #285 load/route seams over inventing a second framework package.  
2. Keep Main ≠ stage scheduler: Main only mutates Product state or emits whitelist `choice_key`.  
3. When adding a capability Graph, copy registration patterns from `hypothesis_cycle` (pack + catalog + platform template + frontend list).  
4. If validate/exploit nodes are “declared but never visited,” fix **edges + projection population**, not a new interpreter mode.

---

## 12. Doc maintenance

Update this file when JSON allow-list, predicate ownership, or registration rules change. Keep index link in `docs/README.md`. Cross-link #285 living Spec for runtime edge semantics.

---

## 13. Grilling decisions (closed)

| ID | Decision |
|----|----------|
| D1 | Success = topology/budget JSON + limited pack autonomy; **not** universal orchestration framework |
| D2 | Narrow JSON surface only |
| D3 | Closed predicate enum + PR to extend |
| D4 | Dual-rail explicit product registration |
| D5 | Fixed typed projection + code builder |
| D6 | Budgets in JSON; soft-land **policy** in code |
| D7 | One L1 Graph per engagement capability |
| D8 | Contract-first Spec (docs + small gaps); no big rewrite |
| D9 (default) | No mandatory `schema_version` until a breaking change |
