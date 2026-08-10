# Spec: Surface coverage v3 — NEW · TESTED · Finding tags (no BOOK chip)

**Status:** Implementable Spec (product contract)  
**Amends:** [`case-surface-ledger.md`](case-surface-ledger.md) / Spec [#368](https://github.com/zangjiaao/my-ai-pen/issues/368) (v2 settle + seen/touched/booked internal)  
**Related:** Asset inventory [#322](https://github.com/zangjiaao/my-ai-pen/issues/322); product state UI [#280](https://github.com/zangjiaao/my-ai-pen/issues/280); Free coverage honesty [#406](https://github.com/zangjiaao/my-ai-pen/issues/406) / soft SEEN harness [#407](https://github.com/zangjiaao/my-ai-pen/issues/407)  
**Field drivers:** Cases `c02e3c20-…`, `5a9cf1f6-…` — operators read Case Surface as “still untested”; Agents treated platform vuln priors as coverage and left Runtime-objective first-touch rows unadvanced; tree chip density (methods + status + severity + rollup) obscured signal.

**Product path:** Node4 Graph × Pi + platform Case Surface tab (ADR 0001).  
**Does not reintroduce:** Soft product mode, dual-kernel, auto-TOUCH without traffic, PRIOR chip, keyword intent routing.

---

## Problem Statement

1. **Two SoTs for “done”:** UI/Surface = this Case Traffic settle. Agent often uses **cross-session platform vulnerabilities** as “already covered” and skips re-request → rows stay first-touch while the operator still sees unfinished work.  
2. **Vocabulary overload:** Operator-facing **seen / touched / booked** plus method chips and severity chips, with **parent rollup** of methods/status/findings, makes origin/root rows unreadable. Adding PRIOR would worsen density.  
3. **BOOK status duplicates Findings:** Successful confirm already hangs vuln tags; a third status chip is low value for operators.  
4. **No durable “is this surface new?”** relative to long-lived inventory: every Case looks like a green-field seen flood; priors are misused as a substitute.

---

## Solution (product locks)

### L1 — Three operator axes (do not merge)

| Axis | Meaning | UI |
|------|---------|-----|
| **Novelty** | Is this identity **new to the durable surface inventory** (asset-scoped)? | Optional **NEW** badge only when true |
| **This-engagement exercise** | Did **this Case** put **test-purpose** traffic on it (≥1 exchange)? | **TESTED** — see [`surface-traffic-purpose-and-noise.md`](surface-traffic-purpose-and-noise.md); **not** hit≥2, **not** finding tags |
| **Findings** | Confirmed product issues on this identity | **Finding severity tags only** — **no BOOK status chip** |

### L2 — Runtime objectivity preserved

- Case Surface rows still **birth from Traffic settle + TARGET seed** (v2).  
- **TESTED** advances only via **real Traffic** on that identity (same family of rule as v2 first→later settle). **No Agent upsert to fake TESTED.**  
- Platform vuln history **must not** alone mark TESTED or remove NEW.  
- Internal storage may keep expand–contract maps (`seen`/`touched`/`booked` or equivalents) for Graph gates and migration; **operator vocabulary** is NEW / TESTED / finding tags.

### L3 — Durable inventory + NEW

- Attack-surface identities **precipitate into asset-scoped inventory** (align with Asset inventory Spec #322; Case ledger remains the live engagement projection).  
- **NEW** = identity **first admitted** to that durable inventory (or first observed under product rules for “unknown to inventory”).  
- **Not NEW** = already in inventory from prior Cases/engagements — **no SEEN chip, no PRIOR chip** (quiet row unless TESTED this Case or finding tags).  
- **Old surfaces retested this Case** may become **TESTED** and may hang **finding tags** after confirm — same as new paths.

### L4 — Agent coverage obligation

- **Primary duty:** drive **NEW → TESTED** (or explicit **deadend / skipped_roe** with honesty).  
- **Secondary:** re-verify / deepen **known** inventory as judgment allows; retest **may** mark TESTED + book findings.  
- **Forbidden as coverage proof:** `platform_list_vulnerabilities` / prior titles alone.  
- **Soft settlement** remains: open NEW/untested must not hard-block booking by default; **honest pause** must disclose remaining NEW untested (extend #406/#407 language to NEW/TESTED).

### L5 — UI density

- **Do not show** HTTP method chips on the Surface **tree** by default (methods may remain in data, tooltip, or Agent tool payload).  
- **Do not show** SEEN / BOOK / PRIOR as operator chips.  
- **Parent/root rollup:** prefer **counts** (e.g. NEW n, TESTED n, vuln n) — not union of all child methods, not max-status chip that hides unfinished children, not three severity title chips.  
- Leaf: path label + optional **NEW** + optional **TESTED** + finding tags (capped +N).

### L6 — Naming

| Operator term | Rough v2 internal analogue | Notes |
|---------------|----------------------------|--------|
| **NEW** | (none — inventory novelty) | Not equal to “first traffic this Case” alone if inventory already knew the path |
| **TESTED** | case_tested (≥1 purpose=test this Case; see surface-traffic-purpose-and-noise) | Not multi-hit-only touched; findings orthogonal |
| *(no chip)* | seen only, inventory-known | Quiet — not “untested red” for every historical path |
| *(no chip)* | booked | Finding tags carry the signal |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Surface identity** | Normalized origin_key + path_key (v2 D2/D1). |
| **Case Surface ledger** | This engagement’s live rows (Traffic + seed + confirm side-effects). |
| **Durable surface inventory** | Asset-scoped precipitated identities across Cases (NEW baseline). |
| **NEW** | First time identity enters durable inventory (UI badge). |
| **TESTED** | This Case advanced exercise via real traffic (operator chip). |
| **Finding tag** | Severity/kind chip from confirmed findings linked to identity. |

---

## User Stories

1. As an operator, I want method chips off the tree so roots are readable.  
2. As an operator, I want **NEW** only on truly new surfaces, not every first GET this Case.  
3. As an operator, I want **TESTED** to mean this Case re-hit the path, not “vuln DB has something.”  
4. As an operator, I want vulns as tags only — not a separate BOOK status.  
5. As an operator, when the Agent retests an old path, I want TESTED and/or finding tags without a NEW badge.  
6. As an operator, I want collapsed parents to show **counts**, not a stack of child tags.  
7. As an Agent, I want summary/list to speak NEW / TESTED / finding counts so I manage the right queue.  
8. As an Agent, I must not treat platform priors as coverage complete for NEW untested.  
9. As Runtime, I want TESTED only from Traffic (or retained terminals deadend/skipped_roe).  
10. As Platform, I want dual-write Case ledger + inventory precipitation without inventing surfaces from prose.  
11. As QA, I want fixtures: first inventory admit → NEW; second Case same path → no NEW; second traffic → TESTED; confirm → finding tag without BOOK chip.  
12. As a reviewer, I want living docs amended, not a parallel abandoned status wiki.

---

## Implementation Decisions

1. **Primary seam — UI projection:** Surface tree / summary counts use L5; method chips default off; BOOK/SEEN/PRIOR not shown.  
2. **Secondary seam — Case status mapping:** Expand–contract from v2 write statuses to operator TESTED + internal fields for NEW (inventory flag or join).  
3. **Tertiary seam — Inventory precipitation (#410):** On Platform dual-write of Traffic settle / TARGET seed / booked create, upsert identity into user-scoped `surface_inventory` (origin_key+path_key; optional asset_id via Host match). First admit → Case row `is_new=true` (sticky for the engagement); later Cases → `is_new=false`. Case ledger remains TESTED/traffic SoT. Aligns with Spec #322 as thin novelty baseline — does not redefine Host→Service.  
4. **Agent seam:** Profession + surface tool guidance + soft continue reminders use **NEW untested** queue (replace pure “seen count” copy where inventory is available).  
5. **Upsert:** Must not elevate TESTED rank without traffic (harden if still possible).  
6. **Graph gates:** Keep host-owned package/surface gates; map booked/open internally without forcing BOOK chip on Free UI.  
7. **No auto-TESTED from priors.**  
8. **Docs:** This Spec + thin amend pointers on `case-surface-ledger.md` locked summary; `docs/README.md` index; harness note if soft reminders change.

### Internal map (implementers — not operator UI)

```text
v2 seen + inventory first admit     → UI NEW (optional), not yet TESTED
v2 seen + inventory already known → UI quiet (no SEEN)
v2 + case_tested (purpose=test ≥1) → UI TESTED (single test request enough)
v2 touched without case_tested    → quiet when dual-write has explicit false (browse multi-hit)
v2 booked                         → UI finding tags only (internal booked ok)
deadend / skipped_roe             → retained terminals (muted)
```

Exact “first traffic same Case also first inventory admit” → NEW until TESTED — yes.

---

## Testing Decisions

| Seam | External behaviour |
|------|-------------------|
| UI | Tree shows no method chips; no BOOK chip; NEW only when flagged; parent uses counts when collapsed |
| Settle | Second traffic → TESTED projection; priors alone do not |
| Inventory | Same identity second Case → not NEW; retest → TESTED possible |
| Agent tool | summary includes new/untested and tested counts (names stable for tests) |
| Soft harness | Stop with NEW untested discloses queue; does not hard-block settlement |

Prefer synthetic ledger fixtures over live LLM.

---

## Out of Scope

- Hard settlement refuse solely because NEW untested remain (unless a later product decision).  
- Auto-mark TESTED from platform vulnerability list.  
- PRIOR chip or SEEN chip resurrection as primary UI.  
- Full Capture JS mining (D6.2) as dependency of this Spec.  
- Renaming Finding NEW semantics (orthogonal; keep consistent *concept* only).

---

## Further Notes

- **Why not keep SEEN for “this Case first touch”?** Operator noise and prior confusion; inventory NEW covers “net new surface”; this-Case exercise is TESTED.  
- **Why allow TESTED on old paths?** Retest / re-verify is legitimate; user lock 2026-08-10.  
- **Why asset inventory for NEW?** Case-only novelty re-floods NEW every session and re-teaches the wrong coverage story.

---

## Work tickets

| # | Deliverable |
|---|-------------|
| [#408](https://github.com/zangjiaao/my-ai-pen/issues/408) | Surface tree: remove method chips + collapse rollup to counts |
| [#409](https://github.com/zangjiaao/my-ai-pen/issues/409) | Operator projection: NEW + TESTED; no BOOK status chip |
| [#410](https://github.com/zangjiaao/my-ai-pen/issues/410) | Durable surface inventory + NEW on first admit |
| [#411](https://github.com/zangjiaao/my-ai-pen/issues/411) | Agent + soft harness: NEW→TESTED (priors ≠ coverage) |

**Frontier:** #408 can start immediately. #409 after #408 (soft). #410 after #409. #411 after #409+#410.

## Amendment checklist

- [x] Spec indexed from `docs/README.md`  
- [x] `case-surface-ledger.md` points to this v3 operator model  
- [x] UI declutter (methods / rollup) — #408  
- [x] Operator projection NEW / TESTED / finding tags — #409  
- [x] Durable inventory + NEW admit — #410  
- [x] Agent tool + soft harness + profession copy — #411  
- [x] Tests for operator status label map / tree chrome (#409; inventory + agent seams follow)  
- [x] Tests for inventory first admit → NEW; re-admit → not NEW; TESTED still traffic-objective (#410)  
- [x] Tests for NEW-untested soft harness + upsert cannot fake TESTED + profession markers (#411)  
