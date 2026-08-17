# Spec: Composer Graph + Expert → harness bind (fail-closed)

**Status:** Implementable Spec  
**Issue:** [#284](https://github.com/zangjiaao/my-ai-pen/issues/284)  
**Field case:** `e4876015-ca2d-4c6a-a093-2aeac86275f8` (composer/UI Graph vs Node Free split-brain; Findings empty after re-verify without booking)  
**Depends on:** Spec #277 `participant-session.md`, Spec #278 `graph-catalog-work-mode-ui.md`, Spec #280 Findings SoT  
**Amended (restore UX only):** Spec [#474](https://github.com/zangjiaao/my-ai-pen/issues/474) `composer-case-restore.md` — remount reads Session mode, **not** Case sticky template (B5).  
**Product path:** Graph × Pi + Node4 (ADR 0001). Soft Graph retired.  
**Does not reintroduce:** silent sticky Graph promote from Case alone; Soft scenario Graph; platform NLP invent of engagement/mode.

---

## 1. Purpose

Operators select **which Expert** and **which Graph Workflow** in the product UI. That selection must be the **actual harness** for the next dispatch:

> **@Expert + composer Graph this send = permissioned Expert Graph × Pi for that graph id.**  
> **不指定 = no force mode change (A1).**  
> **Verified / re-verified product issues must reach Case Findings via `finding(confirm)` — chat is not ledger.**

Kill the failure mode from field Case `e4876015-…` where:

1. Case/UI recorded `engagement_template: app_assessment` and Session private fields said `work_mode: graph`, but Node `task_start` ran **`work_mode: free`** (Free OMP multi-phase todos, not Hard Graph stages).  
2. Agent re-probed prior ledger vulns (user-wide list), claimed “19/19 verified” in chat, never called `finding(confirm)` → **this Case Findings panel stayed empty** (correct empty ledger, wrong product outcome).

---

## 2. Product law

| ID | Law |
|----|-----|
| **B1** | User this-turn **composer product Graph id** on send is **explicit permission** to enter that Graph (Spec #278 D4). Platform must resolve `work_mode=graph` and dispatch `engagement_template` / graph id to Node. |
| **B2** | Node with structured Graph intent + pack Graph capability **must** take Expert Hard Graph path (or fail-closed `unavailable` / `task_error`). **Never silent Free** when the user selected a product Graph this turn. |
| **B3** | **Expert @mention / toolbar expert** is the Participant Session identity and pack seat. Dispatch must use that expert’s pack, not a default seat divert. |
| **B4** | Session private `work_mode` / `graph_id` after settle **must match** the harness Node actually started (AgentRow = actual; Spec #278 D2/D6). No “Session says graph, Node free” split-brain. |
| **B5** | Case sticky `engagement_template` alone **must not** promote Free → Graph (Spec #277). Sticky may inform RoE labels only when envelope is already Graph. Composer remount must not treat sticky template as the Graph chip (Spec #474). |
| **B6** | Composer **不指定** does not force exit Graph (A1). Exit Graph still needs permission card. |
| **B7** | Product Findings SoT is the Case ledger. Re-verify / rediscovery of open priors and new product issues require Main `finding(confirm)` with proof (or package auto-ingest + confirm path). Chat/todo/report prose is not a Finding row. |
| **B8** | Structured fields only — no free-text NLP invent of mode/graph id on platform or Node. |

---

## 3. Seams (test high)

Prefer **one primary seam** end-to-end; keep secondary pure seams thin.

| Seam | Behavior |
|------|----------|
| **S1 Work envelope + task_assign (primary)** | Given structured composer `engagement_template` = product graph id on `user_message`, `resolve_work_envelope` → `work_mode=graph`, `graph_id` set; `apply_work_envelope_to_task_assign` **retains** template on wire; Node receives `engagement_template` / `graph_id`. Code: `participant_session.py` + `ws/router.py` `_apply_participant_work_envelope` / `_dispatch_task_assign_to_node`. |
| **S2 Node work path (fail-closed)** | `resolveHardGraph` + `resolveExpertWorkPath`: product graph intent + packRoot → `path=hard`; intent without hard → `unavailable` + `task_error` (never free). Code: `node4/src/runtime/hard-graph-definition.ts`, `session-runner.ts`. |
| **S3 FE composer wire** | When user selected product Graph and pentest expert, every `user_message` / task launch includes `engagement_template` (and expert_id). Case `PUT` sticky is **not** a substitute for the wire field. Code: `ConversationPage.tsx` launch path. |
| **S4 Session settle honesty** | After dispatch, `sessions[expert_id].work_mode` / `graph_id` match envelope **and** Node task_start / panel `work_mode`. If Node fails closed, do not leave Session stuck on graph without a failed/incomplete honest terminal. |
| **S5 Re-verify booking (secondary)** | Free or Graph: when agent re-proves an open prior or new issue, product path is `finding(confirm)` → `vuln_found` on **this Case**. No platform auto-book from chat. Prompt/work.md + optional mid-run harness reminder only (no hardcoded finding titles). |

Primary pure unit seam: **S1 envelope apply** (already tested) + **S2 path decision** (extend tests for “template present ⇒ hard, never free”).  
Highest integration seam: FE send with Graph → platform task_assign JSON includes template → Node task_start `work_mode` is graph/hard_graph (test or scripted smoke).

---

## 4. Acceptance bars

| # | Bar |
|---|-----|
| **G1** | Unit: composer `app_assessment` / `redteam_deep` → envelope graph + applied task_assign keeps template (existing tests stay green; add regression if missing). |
| **G2** | Unit: Node `engagementTemplate: app_assessment` + pentest packRoot → `resolveExpertWorkPath.path === "hard"` (not free). |
| **G3** | Unit: structured Graph intent without hard graph → `unavailable`, not free. |
| **G4** | Dispatch path: when this-turn msg carries product Graph, `_remember_conversation_task` sets Session `work_mode=graph` **and** outbound task_assign includes `engagement_template` (same payload Node sees). |
| **G5** | Fail-closed: if envelope is graph but Node cannot start Hard, surface `task_error` / incomplete — **no** silent Free OMP that still leaves Session as graph without disclosure. |
| **G6** | FE: selecting Graph + send includes `engagement_template` on the WS `user_message` (not only Case PUT). |
| **G7** | A1 preserved: 不指定 / free composer does not force Graph from Case sticky. |
| **G8** | Re-verify booking: work.md / Free+Graph inject still requires `finding(confirm)` for product issues; no new platform NLP; Findings panel remains ledger-only (Spec #280). Optional: when agent lists priors, prompt reminds confirm-with-id after fresh proof (no hardcoded vuln list). |
| **G9** | Docs: this file + index link; cross-link #277/#278. |

---

## 5. Out of scope

- Silent Agent Route / keyword invent of Graph  
- Soft scenario Graph  
- Auto-booking findings without agent `finding(confirm)` / package ingest  
- Changing Case Findings panel to show other Cases’ rows by default  
- Multi-Expert true-parallel Graph  
- Full re-architecture of dual-rail UI chrome  

---

## 6. Implementation notes (agents)

1. **Reproduce first:** field Case showed case PUT + Session graph + Node free — treat “wire field missing” and “Node ignore template” as equally high-priority until G4/G2 both hold.  
2. Prefer fixing at **S1/S3** (ensure template on wire) and **S2** (fail-closed) over adding a third mode policy.  
3. Do **not** make Case sticky mode authority.  
4. `resolveEngagementRoe` default label `app_assessment` is **not** Graph intent — do not use RoE text as harness proof.  
5. Hardcoded user-visible strings / fake findings require user approval per `AGENTS.md`.  
6. **Root cause (field e4876015, fixed):** `resolve_work_envelope` used conversation `completed` + product template to invent C1 `graph_execution=continue` even when this-turn composer (or enter_graph permission) was an explicit enter-Graph. Node then took free-in-envelope OMP while Session settled `work_mode=graph`. Law: **this-turn product Graph / enter card → Hard `run` or `full_restart`**; C1 continue only when Session already Graph + completed + composer free/absent (or explicit continue wire). Do not collapse `continue` (C1) and `resume` (#282) synonyms.  
7. **Composer sticky after Graph complete (intentional B1 / dual-rail):** FE does **not** auto-reset Workflow to 不指定 after Graph `completed` (Spec #278 D3: composer is user preference, not overwritten by sticky/heartbeat). While a product Graph id remains selected, **every send is re-enter Hard** (`full_restart` when completed). Operators who want C1 free-in-envelope after complete (or `resume` after incomplete) must leave Workflow as **不指定**. Same selected Graph id on incomplete Session also re-enters Hard (`run`, not wire `resume`) — park attach still works without wire `resume`; prefer `resume` only when composer is free/absent. Product UX copy (“selected Workflow = re-enter Hard; 不指定 = continue Session”) is welcome; auto-reset composer or “same-id = C1” would be a **law change** and needs owner approval.  
8. **G5 residual (Session settle vs Node terminal):** Platform still writes Session `work_mode=graph` from the envelope **before** Node `task_start`. If Node fail-closes (`unavailable` → `task_error` / `failed`) or chatOnly forces free despite Graph intent, AgentRow may briefly show Graph until terminal settlement. Node path is fail-closed (no silent Free OMP under Graph intent). Follow-up: settle Session from Node terminal / roll back graph Session on `task_error`.  
9. **Free composer wire aliases (lockstep):** platform `participant_session._FREE_COMPOSER_KEYS` and FE `FREE_COMPOSER_WIRE_ALIASES` must match: empty, `free`, `none`, `off`, `false`, `null`, `unspecified`, `不指定`. Unit tests on both sides pin the set.  
10. **Product SOT for graph_execution:** only `resolve_work_envelope` (enter-Graph / incomplete resume / C1). Do not reintroduce dual law in dead C1 helpers. Explicit wire: `parse_explicit_graph_execution`. Completed terminals: `is_completed_like_status`.

---

## 7. Doc maintenance

Update this file when acceptance bars or seams change. Link from `docs/README.md`. Amend #277/#278 only with cross-links, not contradictory law.
