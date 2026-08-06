# Research: code reality vs map #213 decisions (rebase audit)

> Ticket: GitHub **#307** · Map **#213** (Composable Graph assembly — Route × Case Handoff × Goal)  
> Repo sources only — **facts, not product decisions**. No product feature code.  
> Date: 2026-08-07 · branch `research/map-213-code-rebase-audit`

## Audit ref

| Field | Value |
|-------|--------|
| **Working tree audited** | Product code at commit **`ea1c7c2`** (`fix(node4): Spec #302 Grok-like subagent limits`) |
| **Branch created from** | `feat/timeline-activity-liveness-305` HEAD (same commit; #305 WIP stashed, not in audit) |
| **main at audit** | `5703a14` (audit HEAD is **ahead** of main: #301 + #302) |
| **Assignee** | `zangjiaao` on #307 (already set) |
| **Prior research commits (not on main)** | #214 `5a6299e`, #215 `426ba2e`, #207 `e007e90`, #206 `296161b`, #198 `621441b` — docs exist on research branches only; claims re-checked against **current** tree |

**Product Specs shipped since map grillings (#216–#218, ~late Jul) that re-shape the map:**  
#277 Participant Session · #278 Graph catalog dual-rail · #282 mode continuity · #283 working-session park · #284 composer↔harness bind · #285 engagement edges · #286 Graph JSON boundary · #301 worker bind · #302 subagent limits.

---

## Executive matrix

| Map claim / lock | Status vs code | Notes |
|------------------|----------------|-------|
| Route ≠ Handoff vocabulary | **Partial** | Spec #277 renames/rejects bare “Handoff” and **rejects standalone Agent Route**; Expert transfer still `kind=handoff`; Case multi-run Handoff schema **not** unified |
| Compose unit = one Graph run | **Accurate** | One `resolveHardGraph` per `task_assign`; multi-round assembly loop **not** productized |
| Goal adopt; never silent `t_host` | **Gap (not built)** | Goal = free OMP anchor only; no Case Workset adopt; no family taxonomy on wire |
| Expert first Route; sticky = hint | **Superseded by #277** | Sticky **not** mode authority; default Free; **no** mandatory T1 Agent Route |
| Suggestions at settle | **Partial** | Free settle: host OOS `next_scope`; Hard: closeout residual **only** |
| L1 DAG not V1 | **Partial drift** | Linear hard-order still default; **#285** engagement edges shipped on product graph(s) (in-graph route, not #191 canvas) |
| #216 Route authority law | **CONFLICT** | Living product law = **#277**, not #216 T1/T2 Agent Route |
| #216 UI 工作流 / 不指定 / thin wire | **Mostly implemented** | Dual-rail + envelope; **no** `route_target` field |
| #217 Case Handoff schema | **Not implemented** | Spine = `case_context` + ledger + residual closeout |
| #218 Next-Scope families + Goal adopt | **Not implemented** | Host-OOS free path only |
| #215 free next_scope; Hard no candidates | **Still accurate** | |
| #214 sticky forces Graph; C1 after complete | **Partially stale** | Sticky force **fixed** (#277); C1 **refined** (#282 continue vs resume) |
| #207 Goal not multi-round Graph | **Still accurate** | |

---

## 1. Charting locks (#213 Notes)

### 1.1 Route vs Handoff

| Lock | Code / living Spec fact |
|------|-------------------------|
| **Route** = who runs + Graph/free | **No** dedicated Route resolver. Mode path = `resolve_work_envelope` in `platform/backend/app/services/participant_session.py` + Node `resolveHardGraph` / `resolveExpertWorkPath` (`node4/src/runtime/hard-graph-definition.ts`). Judgment “work Free vs propose Graph” is **inside Free Session** (Spec #277 §3.2), not a pre-work Route kernel. |
| **Handoff** = Case·State·Store continuity | **Not** one Handoff object. Closest: `case_context` (`platform/backend/app/services/case_context.py`), asset/vuln ledger, Case sticky RoE fields (`case_engagement.py`), session-private mode in `context.sessions[expert_id]`. |
| Expert transfer | Still live: `request_user_decision(kind=handoff|…)` + WS authorize (`platform/backend/app/ws/router.py`). Spec #277 calls this **Expert transfer**, not Case multi-run Handoff. |

**Verdict:** Vocabulary lock still useful; **implementation identity of “Route” was rewritten by #277**. Map should not treat #216 Route as buildable SOT without rebasing on #277.

### 1.2 Compose unit = Graph run

| Fact | Path |
|------|------|
| Multi Hard Graph files (pentest) | `experts/pentest/graphs/hard/{app_assessment,redteam_deep,hypothesis_cycle,app_assessment_thin}.json` |
| Node catalog aliases | `PRODUCT_GRAPH_CATALOG` in `hard-graph-definition.ts` (includes **hypothesis_cycle** — post-#214) |
| UI product templates | `ENGAGEMENT_TEMPLATES` in `platform/frontend/src/lib/experts.ts` — **3** ids (assessment / deep / hypothesis) |
| Per-assign resolve | `resolveHardGraph` → one definition; `resolveExpertWorkPath` → hard \| free \| unavailable |
| Multi-round “optional new graphId under Goal” | **Missing** — no orchestrator; switch Graph = permission (`switch_graph` / composer this-turn) + often `full_restart` |

**Verdict:** Compose-unit **framework** still true; **assembly product loop** still missing (same as #214).

### 1.3 Goal adopt (`t_host` never silent)

| Fact | Path |
|------|------|
| Goal wire | `goal_mode` / `goal_objective` on assign (`ws/router.py`) — structured only |
| Goal runtime | `node4/src/stores/goal.ts` + free `session-runner` / `loop-policy.ts` |
| Outer continues | Product default `NODE4_MAX_GOAL_CONTINUES` unset/0 = **off**; lab only |
| Hard Graph | Stages do not couple to Goal multi-round; settle once via `settleHardGraphTask` |
| Auto-adopt suggestions → Case workset | **Absent** |
| Silent host Scope expand | Still forbidden for agents; next-scope promote is user/API (`POST …/next-scope`) |

**Verdict:** Safety posture (no silent host expand) **holds by absence of adopt**. Goal-on auto-adopt of `t_surface` **not started**.

### 1.4 Expert first Route / sticky hint only

| Prior (#214 / #216) | Now |
|---------------------|-----|
| Pentest seat defaulted sticky/UI to `app_assessment` → first target assign full Graph | **Fixed:** composer init stays **不指定** / Free (`ConversationPage.tsx` Spec #277 comment; `engagementTemplate` initial `null`) |
| Sticky Case template as mode force | **Rejected:** `case_sticky_template` explicitly **not** mode authority in `resolve_work_envelope` (deleted after signature) |
| Agent mandatory Route at enter expert | **Rejected** by Spec #277 (“No separate Agent Route step”) |

**Verdict:** Sticky-as-hint **implemented**. Charting “Expert first Route” as **mandatory Agent Route** is **product-law superseded** — Free-first + permissioned enter Graph.

### 1.5 Suggestion timing (settle / close-out)

| Path | Emit |
|------|------|
| Free OMP settle | `attack_surface_candidates` + OOS `next_scope_candidates` on `task_complete` (`session-runner.ts` ~787–834) |
| Hard Graph settle | `engagement_closeout` (residual Product state) + thin `task_complete` (`hard-graph-task.ts` + `hard-graph-settlement.ts`) — **no** next-scope / Workset fields |
| Mid-run interrupt probe with suggestions | Not a product default workset emit |

**Verdict:** Settle-primary still true; Hard still **not** a Workset source.

### 1.6 L1 posture (DAG not V1)

| Fact | Path |
|------|------|
| Default graphs | Ordered `stages[]` hard order when `edges` empty |
| Engagement Graph | Spec #285: optional `edges` + `route_budgets`; host-owned route (`engagement-graph-route.ts`) |
| Drawable / authoring UI (#191) | Still out; not product canvas |

**Verdict:** Map “linear OK for V1” still valid; **new seam:** in-graph back-edges already productized for some graphs — #223 grilling should distinguish **#285 engagement edges** vs deferred **#191 DAG authoring**.

---

## 2. Locked decision #216 — Route product law

| #216 lock | Code reality | Rating |
|-----------|--------------|--------|
| Authority: user Workflow > Agent Route > hint > default free | **#277 authority:** user Workflow / permission card > Session mode continue > default Free. **No** Agent-alone Route that writes Graph under 不指定 (A9/A10). | **CONFLICT** with #216 T1 Agent Route; aligns with #277 |
| UI Mode→工作流; default 不指定; no free chip V1 | Composer title/label **工作流偏好**; null = **不指定**; product Graphs only (no Free chip). AgentRow = actual Free/Graph (#278). | **Implemented** |
| Thin wire: `route_target` / `graph_id` / `graph_execution` | Wire: `engagement_template` ↔ graph id, `graph_execution` (`continue` \| `resume` \| `full`), Session `work_mode`/`graph_id`. **`route_target` not present** as product field. | **Partial** (no `route_target`) |
| T1 enter expert + T2 each new Graph round mandatory Route | Not implemented; **explicitly out of product path** (#277 §4.1 table). Enter Graph = composer this-turn or `enter_graph` card. | **CONFLICT / superseded** |
| Sticky must NOT pre-fill wire / force full Graph | Free omit template on wire (`composerEngagementWireFields`); envelope strips Graph when Free; C1 post-complete uses `continue` free-in-envelope; incomplete uses `resume` Hard (#282). | **Implemented** (fixes #214 sticky-force finding) |

**Primary SOT citation:** `docs/specs/participant-session.md` §4.1 — “Standalone **Agent Route** … **Rejected** as product law.”

---

## 3. Locked decision #217 — Case Handoff schema

| #217 piece | Code | Rating |
|------------|------|--------|
| Truth: Scope/RoE, ledger by ref, round outcomes | Scope/target + RoE on Case/task; findings ledger; Hard `engagement_closeout` round residual | **Partial spine** |
| Next Workset `proposed\|adopted\|rejected\|done` | **No** Case Workset state machine | **Missing** |
| Delivery envelope (host-projected `case_context`) | `case_context` attach on `task_assign` | **Shipped spine** |
| Host-gated writes; Agent no silent Scope / no self-adopt | Asset create / next-scope promote user-gated; no Agent self-adopt workset (workset absent) | **Holds** |
| No taskDir ferry | Fresh taskDir; inheritance via Case materials | **Holds** |

**Verdict:** #217 remains a **schema design target**, not code. Closest living pieces are `case_context` + free next_scope + closeout residual — same gap class as #215.

---

## 4. Locked decision #218 — Next-Scope families + Goal adopt

| #218 lock | Code | Rating |
|-----------|------|--------|
| Families `t_surface` + `t_host` | Free settle hosts only (`attack-surface.ts` from finding locations; `in_scope` flag). No Case `t_surface` deepen worklist. | **Host-only partial** |
| Goal on: auto-adopt only in-scope `t_surface` | No adopt path at all | **Missing** |
| Goal off: human confirm | N/A until adopt exists; next-scope UI already human confirm for hosts | **N/A / partial** |
| Hard settle must emit Workset proposed | Hard settle emits closeout residual only (`engagement-closeout.ts`) | **Still gap** |

---

## 5. Prior research claims re-check

### 5.1 #215 — free next_scope; Hard no candidates

| Claim | Re-check @ `ea1c7c2` |
|-------|----------------------|
| Free path emits `next_scope_candidates` (OOS hosts) | **Still true** — `session-runner.ts` |
| Hard settle has no next-scope / attack-surface on `task_complete` | **Still true** — `settleHardGraphTask` fields: harness status only; closeout separate |
| Live Default→expert = `kind=handoff` card | **Still true** (+ enter_graph kinds for Graph permission) |
| Case inheritable truth ≠ unified Handoff workset | **Still true** |

### 5.2 #214 — multi graphId + sticky / C1

| Claim | Re-check |
|-------|----------|
| Multi Graph files + catalog | **True** — plus **hypothesis_cycle** product template (new since #214) |
| Product UI templates | **3** (was 2) |
| Sticky switch + C1 continue blocks accidental full re-run | **C1 still true**; incomplete **resume** split (#282) is new refinement |
| Sticky / seat default forces Graph | **STALE** — #277/#278/#284 fixed silent Graph from sticky / seat default |
| Compose multi-round assembly not productized | **Still true** |

### 5.3 #207 — Goal does not multi-round Graph

| Claim | Re-check |
|-------|----------|
| Goal orthogonal to Hard Graph schedule | **Still true** |
| No second full Graph from Goal | **Still true** |
| Goal outer continue lab-only by default | **Still true** (`loop-policy.ts` / env) |

---

## 6. New seams map #213 never charted

| Seam | Why it matters for #213 |
|------|-------------------------|
| **Participant Session** (`conversation_id + expert_id`) | Session-private `work_mode` / `graph_id` / `parked_graph` — multi-round continuity is **Session-scoped**, not only Case sticky |
| **`resolve_work_envelope`** | Sole platform mode SOT for dispatch; replaces imagined Route resolver |
| **`graph_execution` trichotomy** | `run` / `continue` (C1 free-in-envelope) / `resume` (incomplete Hard) / `full_restart` / `resume_parked` |
| **#278 L1 catalog inject + dual-rail UI** | Free Session already sees Graph catalog like skills; Agent proposes enter Graph without silent divert |
| **#285 Engagement Graph edges** | In-graph multi-stage route with back-edges — distinct from multi-**Graph-run** assembly |
| **Working-session park (#283)** | Interrupt→continue retains runtime; not Case Handoff |
| **Permission kinds** | `enter_graph` / `exit_graph` / `switch_graph` beside classic `handoff` |
| **Worker host auto-bind (#301)** | Free/Graph worker binding — orthogonal to Route law but touches “who runs” |
| **Subagent limits (#302)** | Budget/queue — Goal-loop / multi-round cost surface |

---

## 7. Spec #277–#302 vs map claims (touch only)

| Spec | Effect on map #213 |
|------|--------------------|
| **#277** | **Supersedes #216 standalone Agent Route** as product law. Free-first; Graph permissioned. Case multi-run inheritance = optional later residue. |
| **#278** | Implements 工作流 dual-rail + Graph L1 catalog (skill-like) — partial L3a UX without Agent Route kernel |
| **#282 / #283** | Continuity after interrupt; refine C1 vs incomplete — multi-round Session continuity without Case Handoff schema |
| **#284** | Composer Graph this send = Hard bind fail-closed — hardens user Workflow authority |
| **#285 / #286** | In-graph edges + JSON boundary — **L1-adjacent** product motion; not multi-Graph compose unit |
| **#301 / #302** | Worker/subagent — open-ticket packaging noise for #224 only |

---

## 8. CONFLICTS (prominent)

### CONFLICT A — #216 Agent Route law vs living Spec #277 / code

- **#216 / charting “Expert first Route”:** mandatory T1/T2 Agent Route; Agent may select Graph under structured fields after Route.
- **Code + `docs/specs/participant-session.md`:** Free is default judgment loop; **no** Agent-alone Graph under 不指定; enter Graph needs **user Workflow or permission card**.
- **Implication:** Map Destination still wants composable multi-Graph assembly, but **must not** ship a second “Route kernel” that undoes #277. Reopen Destination or amend #216 in Decisions when writing #224 Spec.

### CONFLICT B — #218 “Hard settle must emit Workset proposed” vs Hard settle code

- Hard path: residual closeout only.
- Free path: host OOS next_scope only.
- Neither is a Case Workset with families / adopt states.

### CONFLICT C — #217 unified Case Handoff vs naming in code

- Live string `handoff` mostly means **Expert transfer** / authorization card.
- Case multi-run Truth+Next not implemented under that name.
- Spec #277 warns: never bare “Handoff” for both meanings.

### Non-conflict (still missing, not contradicted)

- Goal multi-round Graph under adopt-until-empty (#207 claim remains true as **gap**).
- `route_target` wire field never appeared (thin-wire partial).

---

## 9. Implications for open tickets #219–#224

| Ticket | Implication from this audit |
|--------|-----------------------------|
| **#219** multi Graph-run prompt from Case | Compose from **`case_context` + Session private + optional future Workset** — not taskDir. Free path already injects Case materials; Graph uses prior snapshot. Grilling should assume **#277 Session Free/Graph**, not pre-#277 sticky Graph default. |
| **#220** Goal multi-round terminal conditions | Still **greenfield product loop**. Current Goal complete gates ≠ multi-Graph assembly terminals. Do not assume Hard settle emits adoptables. |
| **#221** suggestion quality at Graph settle | Hard only has residual_risk / unbooked feedback_ok / open surfaces — **honesty residual**, not Workset quality. Free next_scope quality = host extraction from finding locations only. Spec may need dual bar Free vs Hard. |
| **#222** Default/platform → expert small-task | Live path still `kind=handoff` + sticky expert hydrate. #277 **minimizes** Expert transfer; receiving Session starts Free. Grilling should not reintroduce “mandatory Route then Graph”. |
| **#223** L1 DAG boundary for V1 Spec | Rebase: **#285 engagement edges already product**; #191 drawable still deferred. Lock “L1 not V1 deliverable” means **authoring canvas**, not “zero edges forever”. |
| **#224** Spec packaging for composable Graph assembly | **Must package supersession:** #277/#278/#282–#285 as **accepted law**; #216 Route kernel as **reject/amend**; #217–#218 as schema waves; Goal multi-round as later wave. One build Spec cannot reassert T1 Agent Route without fighting shipped code. |

---

## 10. Thin path index (absolute)

| Concern | Paths |
|---------|--------|
| Work envelope / mode authority | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/participant_session.py` |
| Case sticky / RoE / graph_execution helpers | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/case_engagement.py` |
| Case materials attach | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/case_context.py` |
| next-scope API | `/mnt/d/Coding/my-ai-pen/platform/backend/app/api/conversations.py` (`start_next_scope`) |
| WS remember next_scope / goal / handoff | `/mnt/d/Coding/my-ai-pen/platform/backend/app/ws/router.py` |
| Hard resolve + work path | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-definition.ts` |
| Free settle candidates | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/session-runner.ts`, `attack-surface.ts` |
| Hard settle / closeout | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-settlement.ts`, `hard-graph-task.ts`, `engagement-closeout.ts` |
| Goal store | `/mnt/d/Coding/my-ai-pen/node4/src/stores/goal.ts`, `loop-policy.ts` |
| UI Workflow / 不指定 | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/lib/experts.ts`, `pages/ConversationPage.tsx` |
| Living Spec supersession | `/mnt/d/Coding/my-ai-pen/docs/specs/participant-session.md` §4.1 |
| Graph catalog dual-rail | `/mnt/d/Coding/my-ai-pen/docs/specs/graph-catalog-work-mode-ui.md` |
| Hard graphs on disk | `/mnt/d/Coding/my-ai-pen/experts/pentest/graphs/hard/` |

---

## 11. One-sentence summary

**Multi-Graph catalog, Free-default Session, dual-rail 工作流, and fail-closed composer→Hard bind are shipped; map #213’s Case Handoff Workset, Next-Scope families, Goal multi-round adopt, and #216 mandatory Agent Route are not — and #277 explicitly rejects the Route kernel, so open grillings #219–#224 must rebase Destination packaging on Participant Session law rather than re-litigate sticky-force Graph (already fixed).**
