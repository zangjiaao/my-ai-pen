# Spec: Graph catalog (skill-like) + dual-rail work mode UI

**Status:** Implementable Spec  
**Issue:** [#278](https://github.com/zangjiaao/my-ai-pen/issues/278)  
**Depends on:** Spec #277 `docs/specs/participant-session.md` (Session Free default; enter Graph needs permission; no silent sticky divert)  
**Product path:** Graph × Pi + Node4 (ADR 0001). Soft Graph retired.

---

## 1. Purpose

Operators and Agents need a **skill-like** understanding of which Expert Graphs exist and when to use them, without:

- forcing every complex run into Graph by silent sticky/`app_assessment` defaults, or  
- fighting the composer control against the live Session harness.

---

## 2. Product law (grilling D1–D7 + P0)

| ID | Law |
|----|-----|
| **D1** | Enter Graph requires **user permission**. Skill-like = **catalog + when-to-use**, not silent harness switch. |
| **D2** | **Composer workflow control** = user intent for the next send. **AgentRow** = Session **actual** harness. |
| **A1** | Composer **不指定** does **not** force mode change (if already in Graph, stay in Graph). |
| **D3** | Sync composer → current expert + Graph **only after mode settlement** (enter/exit/switch Graph succeeds). Never continuous overwrite while user edits. **Case remount** is the same once-align from Session actual (Spec [#474](https://github.com/zangjiaao/my-ai-pen/issues/474)) — not a heartbeat overwrite, not Case sticky template. |
| **D4** | Agent proposes enter/exit/switch Graph via **same authorization card path** as handoff. User selecting a Graph in composer and sending = explicit permission (no extra card required). |
| **D5** | Graph overview / when-to-use is **authored inside Graph definitions**; Agent can **list/read** like Skills (L1 catalog; details on demand). Product graphs only by default (`app_assessment`, `redteam_deep`); lab `*_thin` excluded unless later opted in. |
| **D6** | AgentRow shows **`Free`** or short Graph **label** (e.g. 应用评估), from Session actual mode. |
| **D7** | Exit Graph and switch Graph use the **same** propose → permit → settle → sync pipeline as enter. |

**Prefer Free continuity (#277):** judgment starts in Free; complex work may **propose** Graph, not auto-enter.

---

## 3. Seams (test high)

| Seam | Behavior |
|------|----------|
| **S1 Graph L1 catalog (pure)** | From pack hard graph files (or embedded metadata): `{ id, label, when_to_use, allow_postex? }[]` — product ids only. Code: `buildProductGraphL1Catalog` / `loadProductGraphL1Catalog` in `node4/src/runtime/hard-graph-definition.ts`. Authored fields: `when_to_use` (preferred) or `description` alias on hard graph JSON. |
| **S2 System prompt inject** | Free (and Graph) sessions receive L1 catalog text analogous to skill id list; not full stage JSON. `formatGraphL1CatalogInjection` + Free `formatGraphInjection` catalog block. |
| **S3 Work envelope + permission** | User composer Graph this turn → graph mode; Agent enter/exit/switch via `request_user_decision(kind=enter_graph\|exit_graph\|switch_graph, graph_id=…)` → `graph_mode_apply` → Session settle + `work_mode_settled` FE event. |
| **S4 Panel AgentRow** | Display Free vs Graph label from Session/task actual mode on collaboration tree primary row (`work_mode` / `graph_id` / `graph_label` on panel_agents). |
| **S5 Composer dual-rail** | User control not overwritten except D3 settlement events (`work_mode_settled`); 不指定 does not kick Graph (A1). |

Primary pure seam: **S1 catalog builder**.

---

## 4. Acceptance bars

| # | Bar |
|---|-----|
| G1 | Pentest Free system prompt includes product Graph L1 (id + label + when-to-use). |
| G2 | Agent cannot change harness without user permission (card/text feedback or composer explicit Graph send). |
| G3 | AgentRow shows Free or Graph short label matching Session actual mode. |
| G4 | After authorized enter Graph, composer syncs to that Graph once. |
| G5 | Mid-session user changes composer draft without send → not force-reset by agent heartbeats. |
| G6 | 不指定 send while Session is Graph → does not force Free (A1). |
| G7 | Lab thin graphs not listed in product L1 by default. |

---

## 5. Out of scope

- Silent Agent Route / auto `hard_graph` without permission  
- Soft scenario Graph  
- Full progressive “load graph body” tool UI polish beyond L1 + existing runner inject  
- True multi-Expert parallel Graph runs  

---

## 6. Doc maintenance

Update this file and cross-link `participant-session.md` when catalog shape or dual-rail rules change. Composer remount restore: `composer-case-restore.md` (#474). Index in `docs/README.md`.
