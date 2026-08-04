# Lab scorecard: `app_assessment` vs `hypothesis_cycle` (offline D/R)

**Status:** Offline protocol only (Spec [#285](https://github.com/zangjiaao/my-ai-pen/issues/285) S6 / E8)  
**Authority:** `docs/specs/engagement-graph-back-edges.md` §7  
**Product path:** Graph × Pi + Node4. **Never** inject this scorecard, expected vulnerability lists, write-ups, or official walkthroughs into agent-facing prompts.

---

## 1. Arms (same Expert pack, model env, RoE)

| Arm | Graph id | Notes |
|-----|----------|--------|
| Baseline | `app_assessment` | **Frozen** Wave1 topology/process |
| Experiment | `hypothesis_cycle` | Engagement edges + hypothesis-first process |

Independent clean targets per arm (or full reset between arms). Record URLs and graph id on every run.

---

## 2. Targets

| Target | Instance notes (fill per lab) | Arm A URL | Arm B URL |
|--------|-------------------------------|-----------|-----------|
| DVWA | clean / reset | | |
| OWASP Juice Shop | clean / reset | | |

---

## 3. Rubrics (offline human)

### Difficulty (per finding or expected class)

| Tier | Meaning (web lab) |
|------|-------------------|
| **D0** | Shallow: listing, phpinfo, default banners, trivial exposure |
| **D1** | Standard module vulns with single-module proof |
| **D2** | Needs session / dual-actor / level / IDOR conditions |
| **D3** | Multi-step / non-menu / chain-like |

### Evidence reliability (per booked finding)

| Tier | Meaning |
|------|---------|
| **R0** | Missing/mismatched proof |
| **R1** | Fragment only; not independently reproducible |
| **R2** | Reproducible steps + output; impact weak/unclear |
| **R3** | Observation + reproduction + impact clear |

**Headlines (primary):** count of **(D1+ ∩ R2+)**; **D0 share** among booked (lower better).  
**Not primary:** raw finding count; all stages green.

---

## 4. Dual-arm fill grid (copy per run)

**Run id:** _______________ **Date:** _______________ **Model/env:** _______________

### 4.1 DVWA

| Finding / class (offline label) | Arm | Booked? | D | R | Notes (proof gist, not agent-facing) |
|---------------------------------|-----|---------|---|---|--------------------------------------|
| | app_assessment | | | | |
| | hypothesis_cycle | | | | |
| | app_assessment | | | | |
| | hypothesis_cycle | | | | |

**DVWA headlines**

| Metric | app_assessment | hypothesis_cycle |
|--------|----------------|------------------|
| Booked n | | |
| (D1+ ∩ R2+) n | | |
| D0 share among booked | | |
| Hop / back-edge counts (if logged) | | |
| hop_exhausted? | | |
| Terminal | | |

### 4.2 Juice Shop

| Finding / class (offline label) | Arm | Booked? | D | R | Notes |
|---------------------------------|-----|---------|---|---|-------|
| | app_assessment | | | | |
| | hypothesis_cycle | | | | |
| | app_assessment | | | | |
| | hypothesis_cycle | | | | |

**Juice headlines**

| Metric | app_assessment | hypothesis_cycle |
|--------|----------------|------------------|
| Booked n | | |
| (D1+ ∩ R2+) n | | |
| D0 share among booked | | |
| Hop / back-edge counts (if logged) | | |
| hop_exhausted? | | |
| Terminal | | |

---

## 5. Secondary (optional)

| Signal | app_assessment | hypothesis_cycle |
|--------|----------------|------------------|
| Hypothesis status histogram | n/a or partial | |
| Tokens / wall-clock | | |
| Terminal honesty / close-out residual | | |

---

## 6. Agent input ban (repeat)

Do **not** put scorecard text, expected lists, D/R tiers, or this template into:

- stage system/user prompts  
- skill bodies aimed at the Main agent  
- Free/Graph catalog injection beyond normal product L1 `when_to_use`

Comparison is **offline human** fill only.
