# Spec: Optional hypothesis–evidence work mode (Expert Graph)

**Status:** Implementable Spec (Wave 1 normative; Wave 2 normative)  
**Map:** [Wayfinder: Hypothesis–evidence work mode Spec](https://github.com/zangjiaao/my-ai-pen/issues/266)  
**Decisions:** grillings [#267](https://github.com/zangjiaao/my-ai-pen/issues/267)–[#271](https://github.com/zangjiaao/my-ai-pen/issues/271), [#273](https://github.com/zangjiaao/my-ai-pen/issues/273) (+ L1 catalog addendum)  
**Inputs:** [#261](https://github.com/zangjiaao/my-ai-pen/issues/261) research; `docs/wayfinder/research-black-cat-platform-learnings.md`; `docs/wayfinder/research-skill-load-industry.md`  
**Product path:** Graph × Pi + Product state (ADR 0001). **No product code in this document.**

---

## 1. Purpose

Define an **optional Expert Graph work mode**: structured **hypothesis working memory** (exploration) plus **progressive skill disclosure** (domain knowledge into context)—without replacing Hard Graph, Finding Store booking, or Default seat.

| Goal | Non-goal |
|------|----------|
| Cross-stage (and promote-based cross-Graph) memory of 已立 / 已否 / 未决 | Black-cat full state machine name copy (`IDLE→RECON→…`) |
| Main steers queue; Sub verifies packages | Second booking channel or Active→confirm bypass |
| Thin platform **socket** + pack/Graph **plug-in** | Per-expert Node runner / schema zoo |
| Claude-style skill **catalog** + Agent **open handbook** | Host max-2 active skills + mandatory unload FSM |
| Pentest as **first reference pack** | Pentest-only platform fields (CVE enums in core) |

---

## 2. Vocabulary

| Term | Definition |
|------|------------|
| **Hypothesis work mode** | Optional capability: host-backed **hypothesis queue** while a stage has `hypothesis_work_mode: true`. |
| **Hypothesis queue** | Run-local Product-state working memory of exploration candidates and outcomes. **Not** Finding Store; **not** platform vuln ledger. |
| **Hypothesis (row)** | A proposition worth verifying: signal, statement, prove/disprove conditions, lifecycle status, pack payload. |
| **Lifecycle** | `active` → `confirmed` \| `killed` \| `deferred` (revisit retained for killed/deferred). |
| **Pack availability** | Pack declares it **offers** the mode; does not alone enable any stage. |
| **Skill (L1/L2/L3)** | Pack methodology unit under `experts/<pack>/skills/<id>/SKILL.md`. L1 = metadata index; L2 = body; L3 = refs/scripts on demand. |
| **Progressive disclosure** | Always-cheap catalog; body only when Agent loads; refs only when needed. |

**Related existing terms (do not redefine):** Product state, Runtime transcript, Finding Store, book-path L0, surface ledger, Package/Wave, Feedback L0/L1, Handoff Truth/Next/Delivery — see `CONTEXT.md`, `docs/specs/task-graph.md`, `docs/specs/harness.md`.

**Routing bind (Spec [#285](https://github.com/zangjiaao/my-ai-pen/issues/285)):** queue/surface projections may feed **host-owned** Engagement Graph route predicates (`hypothesis_cycle`). This Spec still owns the queue; #285 owns declarative edges + hop budgets — see `docs/specs/engagement-graph-back-edges.md`.

---

## 3. Wave plan

| Wave | Scope | Implement independently? |
|------|--------|---------------------------|
| **Wave 1 — Process contract** | Queue schema, Main/Sub writeback, stage/pack enablement, Store boundary, hang/promote | **Yes** — primary dig-honesty path |
| **Wave 2 — Progressive skill disclosure** | Host auto L1 catalog; Agent L2 load; soft anti-bulk; orthogonal to queue flag | **Yes** — can ship with or after Wave 1 |
| **Out of Spec DoD** | Pack content thickness / Black-cat technique inventory parity | Separate pack iteration |

Both waves are **normative in this Spec**. Implementation may phase delivery; Spec completeness requires both sections written (this document).

---

## 4. Wave 1 — Process contract

### 4.1 Placement: thin platform socket + pack plug-in

| Layer | Owns |
|-------|------|
| **Platform / Node4** | Optional, domain-agnostic **hypothesis memory** capability: lifecycle slots, Main commit API, Sub outcome shape, settlement/Store **boundary**, run hang points, promote hooks. |
| **Pack** | Availability flag; candidate **payload** schema extension; knowledge skills; graph JSON stage flags. |
| **Graph stage** | Explicit `hypothesis_work_mode: true` to enable queue for that stage. Packs without a declared Graph never require this mode. |

**Anti-bloat:** Prefer “existing mode + new payload / Graph switch” over new meta-modes. New meta-mode only if a **second expert** reuses the shape.

### 4.2 Enablement (stage-explicit)

| Layer | Rule |
|-------|------|
| **Pack** | Declares **availability** only (e.g. `pack.capabilities.hypothesis_work_mode: true` or equivalent). |
| **Stage** | **Authoritative on/off:** `hypothesis_work_mode: true` required. **Missing / false = off.** |
| **Intent** | `probe` / `explore` alone **do not** enable the mode. |
| **Fail-closed** | Stage sets `true` but pack availability false → **fail at graph load** (clear error). |
| **Reference graphs** | Pentest explore/probe stages **explicitly** set `true` in shipped JSON (documentation by example, not magic default). |

### 4.3 Authority and write path

| Rule | Detail |
|------|--------|
| **SOT** | Host **Node4 Product state** (structured store). Not Runtime transcript, not agent markdown tracker as gate SOT. |
| **Main** | **Only** Main commits lifecycle transitions (`active` / `confirmed` / `killed` / `deferred`) and queue edits. |
| **Sub** | Returns **structured package outcomes** only, e.g. `proved` \| `disproved` \| `inconclusive` + evidence pointers + optional hypothesis id. **Must not** mutate global queue directly. |
| **Main apply** | Main maps Sub outcomes into queue commits and re-dispatch / Deferred strategy (boss loop compatible). |

### 4.4 Stage settlement L0

| Rule | Detail |
|------|--------|
| **L0 never reads the queue** | Empty/full Active does **not** alone cannot-advance. |
| **Queue role** | Steers Main strategy and package goals only. |
| **Book-path L0** | Unchanged: Store proof / severity / invent-without-id only. |

### 4.5 Boundary vs Finding Store and booking

| Rule | Detail |
|------|--------|
| **No bypass booking** | Queue rows (including `confirmed`) **cannot** `finding(confirm)` or platform-ledger book without Store `feedback_ok`. |
| **Sole booking path** | Store candidate → book-path L0 → `feedback_ok` → Main `finding(confirm, finding_id)` → platform. |
| **Confirmed → Store** | **Main-mediated seed:** queue `confirmed` may seed Store upsert (auto-suggest upsert OK); **confirm remains explicit**. Confirmed ≠ booked. |
| **Killed / Deferred** | **Never** platform vuln / Case ledger rows. Exploration assets only (queue + optional close-out / summary projection). |
| **Book stages** (`validate_book`-class) | **Consume Store only** for completion and L0. Queue may appear as **informational projection** (“confirmed not yet seeded”); must not hard-require non-empty Active. |

### 4.6 Hang location and cross-Graph continuity

| Scope | Behavior |
|-------|----------|
| **Within Graph run** | Run-local Product-state queue is **sole authority**; survives stages while enabled stages use it. |
| **Across Graphs / Case** | **No live shared queue by default.** Continuity = **promote → Handoff / Case materials** (summary-oriented). |
| **Promote (default)** | On Graph terminal / close-out: summary (counts + ids/gist for active/killed/deferred). Full dump optional/explicit. |
| **Next Graph** | Delivery / `case_context` projects gist. Main may **copy-in / re-seed** into the **new run’s** host queue when a stage has `hypothesis_work_mode: true`. Not co-mutation of a shared multi-run table. |
| **Chat** | Never SOT. |

### 4.7 Minimal schema (platform slots)

Platform-normative fields (names illustrative; implement under Product state):

```text
HypothesisRow {
  id: string
  status: active | confirmed | killed | deferred
  statement: string              # the proposition
  signal: string                 # why raised
  prove_if: string               # success criteria
  disprove_if: string            # kill criteria
  revisit_if?: string            # for killed | deferred
  priority?: string | number
  evidence_refs?: string[]       # paths / store ids / observation pointers
  package_ids?: string[]         # packages that touched this row
  payload?: object               # pack-defined extension (domain-specific)
  updated_at: string
}
```

**Pack payload:** e.g. vuln class, CTF flag path, audit module id — **not** platform-fixed CVE enums.

**Sub outcome (illustrative):**

```text
HypothesisPackageOutcome {
  hypothesis_id?: string
  result: proved | disproved | inconclusive
  evidence_refs?: string[]
  notes?: string
  suggested_revisit_if?: string
}
```

### 4.8 Main tool surface (illustrative)

Implement as host tools or equivalent APIs (names free as long as semantics hold):

| Op | Actor | Effect |
|----|-------|--------|
| `hypothesis.list` / projection in prompt | Main (read) | Active / killed / deferred views |
| `hypothesis.upsert` / `activate` | Main | Create or edit active rows |
| `hypothesis.commit` | Main | Transition to confirmed / killed / deferred with required fields |
| Package settlement | Host + Main | Ingest Sub `HypothesisPackageOutcome` → Main commits |

Sub keeps existing package settlement path; extend structured settlement with optional hypothesis outcome fields.

### 4.9 Stage prompt obligations (when mode on)

When `hypothesis_work_mode: true`:

1. Host projects **current queue summary** into stage/Main context (budgeted).
2. Main packages should bind `this_turn_goal` / `success_criteria` to prove/disprove where applicable.
3. Soft harness: prefer diverse actives with disprove conditions before tunnel vision (not a fixed finding-count gate).

---

## 5. Wave 2 — Progressive skill disclosure

### 5.1 Mental model

| Layer | Metaphor | Who | Context content |
|-------|----------|-----|-----------------|
| **L1 Auto catalog** | 目录 | **Host** | id / name / description for pack-filtered skills |
| **L2 Load body** | 翻开手册 | **Agent** | Full `SKILL.md` via `skill(op=load)` (or equivalent) |
| **L3 Refs** | 附录 | **Agent** | `refs/` / scripts only when needed |

- **Low interference** = low interference on **which** skill to open, **not** on **whether the agent knows the shelf exists**.
- **Orthogonal** to `hypothesis_work_mode`: skill path is **one** product-wide when skill tool is on the surface.

### 5.2 Normative rules

| Rule | Detail |
|------|--------|
| **Unit** | Pack skill directory + `SKILL.md` frontmatter (`name`, `description`). |
| **Who chooses L2** | **Agent** (Main or Sub) via skill tool. No host forced skill pick; no platform free-text keyword invent of engagement or skill id from user chat (AGENTS.md). |
| **L1 host catalog** | When stage tool surface includes `skill`, host **injects or maintains** L1 catalog (pack `skillIds` scope). Prefer not re-dumping full index every turn if unchanged. |
| **L2** | Agent must `load` to obtain body. Soft guidance: prefer focused load; do not bulk-load all bodies. |
| **Hard max-active / unload FSM** | **Out of V1 default.** Not mainstream (see industry research). Do not require unload-then-reselect. |
| **Dedupe (recommended)** | Re-load same id with identical body → short “already loaded” note, not second full copy. |
| **No skill tool / empty skillIds** | No deep methodology load for that seat/stage (cap=0 by absence). |
| **Heavy domains** | Expressed via skill descriptions + pack availability + tool profiles / RoE — not a second load mode. |

### 5.3 Relation to existing Node4

Today: `skill` tool `list` \| `load` (`node4/src/tools/skill.ts`, `SkillStore`). Wave 2 **extends** with **host L1 auto-catalog** when skill is on the surface; keeps Agent-owned L2. Aligns with Claude/Grok progressive disclosure (`docs/wayfinder/research-skill-load-industry.md`).

### 5.4 Soft pack language (non-gate)

Packs (e.g. pentest `work.md`) may say: start with at most one deep methodology skill; rotate by loading another when stuck; never load the whole catalog as bodies. **Prompt steering only** — not stage L0.

---

## 6. Reference implementation notes (pentest)

| Item | Guidance |
|------|----------|
| Pack availability | `pentest` enables capability. |
| Graphs | `app_assessment` / `redteam_deep`: set `hypothesis_work_mode: true` on explore/probe stages (`class_probe`, `authz_logic`, …); **false/omit** on `init`, `validate_book` (book consumes Store only). |
| Payload | Optional: attack class, path keys, severity draft — still book only via Store. |
| Skills | Existing `experts/pentest/skills/*`; L1 catalog from pack skillIds; Agent loads e.g. `pentest-sql-injection` when recon signals match description. |
| Not required | Copy Black-cat `RECON/ENUMERATE/VALIDATE` stage names. |

Other experts (CTF, code audit): same socket; different payload + skills; stage flags explicit.

---

## 7. Non-goals and anti-patterns

| Forbidden / out of scope | Why |
|--------------------------|-----|
| Replace Graph × Pi with skill-only kernel | ADR 0001 |
| Brand product as classic multi-KS blackboard | Vocabulary lock (#261 research) |
| Agent markdown Engagement Tracker as **gate** SOT | Host Product state is law |
| Active → platform confirm without Store | Second booking channel |
| Stage L0 gated on non-empty Active | Ritual / answer-key pressure |
| Force all Graphs / Default into mode | Optional Expert Graph only |
| Host hard max-2 skills + mandatory unload | Atypical; high friction (#273) |
| Host auto-inject full skill **bodies** | Breaks progressive disclosure |
| Platform-fixed CVE / domain enums as only payload | Expert zoo |
| Content encyclopedia as Spec DoD | Pack iteration elsewhere |
| Live multi-Graph shared mutable queue | Complexity; use promote/Handoff |

---

## 8. Implementation checklist (for build pass — not this map)

**Wave 1**

- [x] Product-state hypothesis store (run-scoped)
- [x] Main commit APIs + prompt projection
- [x] Sub settlement fields for hypothesis outcomes
- [x] Graph JSON: pack availability + per-stage `hypothesis_work_mode`
- [x] Graph load fail-closed on availability mismatch
- [x] Promote summary on close-out / Case materials
- [x] Delivery seed copy-in for next Graph
- [x] Enforce Store boundary (no confirm from queue alone)
- [x] Tests: Main-only write; L0 ignores queue; kill/defer not ledger rows

**Wave 2**

- [x] Host L1 catalog injection when `skill` on tool surface
- [x] Keep `list`/`load`; optional load dedupe
- [x] Soft anti-bulk in harness/pack prompts only
- [x] Tests: catalog present without body bulk; Agent load still required for body

---

## 9. Doc index / cross-links

| Doc | Relationship |
|------|----------------|
| `CONTEXT.md` | Add glossary terms when implementing (Hypothesis work mode, queue) — optional follow-up |
| `docs/specs/task-graph.md` | Stage settlement / Store / close-out remain SoT for Graph gates |
| `docs/specs/harness.md` | Skill tool, progressive load language, package contract |
| `docs/wayfinder/research-black-cat-platform-learnings.md` | Why process + knowledge legs |
| `docs/wayfinder/research-skill-load-industry.md` | Why progressive disclosure over unload FSM |

---

## 10. Revision

| Date | Change |
|------|--------|
| 2026-08-01 | Initial Spec from map #266 grillings #267–#273 |
| 2026-08-01 | Implemented in Node4 (issue #274): HypothesisStore + Main tool, stage flag, promote/re-seed, skill L1 catalog |
