# Spec: Surface traffic noise filter + test-purpose (TESTED)

**Status:** Living Spec — **shipped** (noise filter [#412](https://github.com/zangjiaao/my-ai-pen/issues/412); purpose→TESTED [#413](https://github.com/zangjiaao/my-ai-pen/issues/413); dual-write preserve in [#414](https://github.com/zangjiaao/my-ai-pen/pull/414)). Product contract remains normative.  
**Amends:** [`case-surface-ledger.md`](case-surface-ledger.md) (D6 settle), [`surface-new-tested-coverage.md`](surface-new-tested-coverage.md) (TESTED axis)  
**Related:** Spec [#368](https://github.com/zangjiaao/my-ai-pen/issues/368); inventory NEW [#410](https://github.com/zangjiaao/my-ai-pen/issues/410); field Cases `f7f55cea-…` (noise + all-NEW cold start), `760e07b9-…` (dual-write)

**Product path:** Node4 Graph × Pi + platform Case Surface (ADR 0001).

---

## Problem Statement

### Problem 1 — Traffic noise enters Surface

Traffic→Surface settle was **request-as-row** with only a **static suffix denylist**. It did **not** consult TARGET / `scope.allow`. Agent probes therefore landed:

- Out-of-scope origins (`www.w3.org`, `nonexistent-host:9999`)
- Tool garbage paths (`/ftp/${pdf}`)
- Path-normalized probe artifacts (`…/../../../etc/passwd` → `/etc/passwd` on target)

Operators treat Surface as **target attack-surface inventory**; noise rows destroy trust.

### Problem 2 — TESTED ≠ “hit count ≥ 2”

Operator **TESTED** must mean **this Case exercised this identity with test traffic**, not:

- second identical browse GET, or  
- finding tags alone, or  
- internal `touched` only after multi-hit while first-hit book skips TESTED chip.

Product lock (operator grill):

- TESTED answers **测 / 未测 only** — not是否有洞 (findings own that).  
- **One test-purpose exchange is enough** (including re-verify of old vulns).  
- Need a durable way to classify exchanges as **test vs non-test** (tool default + heuristics).

---

## Solution locks

### L1 — Two independent seams

| Seam | Job |
|------|-----|
| **Noise filter (settle gate)** | Which exchanges may create/update Surface identities |
| **Purpose classification** | Which in-ledger (or in-scope) exchanges mark **TESTED** |

Do **not** invent a UI “noise” chip. Reject or skip at settle; purpose lives on Traffic.

### L2 — Noise: do not settle into Surface

Skip Surface settle (no Case row, no inventory admit) when any apply:

1. **Origin out of engagement scope** — `origin_key` host/port not in TARGET value and not covered by `scope.allow` entries (parse allow URLs/hosts; support same-host alias rules already used elsewhere if present). Out-of-scope HTTP may still be stored in **Traffic** audit.  
2. **Unexpanded tool variables in path** — path contains `${` or `{{` (shell leftovers).  
3. **Existing static suffix denylist** — unchanged (`.js`, `.css`, images, …).  
4. **Optional (same ticket if cheap):** path segments that are pure traversal collapse to OS-file-looking paths (`/etc/passwd`, `/windows/win.ini`) **from a URL that contained `..`** — skip settle or keep raw non-collapsed identity; prefer **skip settle for collapsed OS probe paths** to avoid fake business surfaces.

**In-scope** 4xx/5xx and real business paths (including easter-egg paths on TARGET) **may** still settle — not “noise” under L2; cardinality of `/ftp/*.pdf` is **not** this Spec’s first cut (optional later).

### L3 — Traffic `purpose`

Each settled-capable exchange carries:

```text
purpose: test | browse | setup | noise | unknown
```

| purpose | Meaning | Drives TESTED? |
|---------|---------|----------------|
| **test** | Security probe / retest / verify | **Yes** (≥1 on identity) |
| **browse** | Navigation / casual open | No |
| **setup** | Seed, login-for-cookie, health | No (login-as-vuln-test should be **test** via tool flag or probe shape) |
| **noise** | Out-of-scope or garbage (if still recorded on Traffic) | No; should not settle Surface |
| **unknown** | Insufficient signal | **No** (fail-closed for TESTED) |

**Classification order:**

1. **Tool / collect declaration** (highest): caller sets purpose when emitting traffic.  
2. **Defaults by tool family:**  
   - `shell` / `http` / `session` act requests → default **`test`** (pentest seat).  
   - `browser` ordinary navigation → default **`browse`**.  
   - TARGET seed → **`setup`**.  
3. **Heuristics when unset:** out-of-scope → `noise`; path has `${` → `noise`; non-GET write methods → `test`; clear probe path shapes → `test`; else keep default or `unknown`.

Store purpose on the **Traffic exchange** (Node collect + dual-write if Traffic is mirrored). Surface row stores derived **`case_tested`** (or equivalent) when any **test** purpose hits that identity this Case.

### L4 — Operator TESTED

```text
TESTED  ≔  this Case has ≥1 exchange with purpose=test on that identity
           (single test request is enough; re-verify old vulns counts)
未测    ≔  no test-purpose traffic this Case
```

- **Findings / booked do not define TESTED** (orthogonal). Prefer that booking still followed real requests; if create-on-book without traffic remains possible, either require traffic or set `case_tested` on successful book as a narrow exception (document in implementation).  
- **Internal** `seen`/`touched` may remain for Graph; **operator chip** uses L4, not “second hit only”.  
- Projection: show **TESTED** when `case_tested` (or purpose-derived flag); do not require status=`touched`.

### L5 — Agent / harness

- Untested queue = identities that settled (or NEW) **without** `case_tested`.  
- Soft reminders speak **test-purpose / case_tested**, not bare hit counts.  
- Upsert still cannot fake TESTED without traffic (or without allowed book side-effect if exception locked).

### L6 — No PRIOR / noise chips

Noise is filtered at settle. NEW remains inventory novelty only.

---

## Domain terms

| Term | Meaning |
|------|---------|
| **purpose** | Per-exchange classification on Traffic |
| **case_tested** | Surface identity flag: ≥1 test-purpose hit this Case |
| **scope gate** | Settle only in-scope origins |
| **TESTED chip** | Operator UI for case_tested |

---

## User Stories

1. As an operator, I do not see w3.org / fake hosts on the Surface tree for a scoped web target.  
2. As an operator, I do not see `/ftp/${pdf}` as a surface.  
3. As an operator, TESTED means “this Case had test traffic,” including one retest request.  
4. As an operator, a finding tag does not replace TESTED logic; a tested-clean surface can show TESTED without a vuln tag.  
5. As an Agent author, shell/http defaults to test purpose so I need not annotate every curl.  
6. As Runtime, out-of-scope traffic can remain in Traffic audit without polluting Surface.  
7. As QA, fixtures cover scope skip, `${` skip, purpose defaults, single test → TESTED, browse-only → not TESTED.

---

## Implementation Decisions

1. **Classify** in Node traffic-collect (or adjacent pure module) before/with settle.  
2. **planTrafficSurfaceSettle** (or wrapper) applies L2 gates using task target/scope from runtime.  
3. **Surface SQLite + platform ledger** carry `case_tested` (bool) sticky true once set; dual-write includes field for FE.  
4. **FE** `surfaceStatusLabel` / chrome: TESTED iff `case_tested` (or mapped field); stop using multi-hit-only touched as sole TESTED signal.  
5. **Tests** pure classify + settle plan + projection; no live LLM.  
6. **Docs:** this Spec + thin amend on surface-new-tested-coverage L2/L6 TESTED definition; case-surface-ledger D6.1 noise/scope note.  
7. **Migration:** only if platform snapshot schema needs explicit column (JSON context field may suffice).

---

## Testing Decisions

| Seam | Behaviour |
|------|-----------|
| Scope | allow TARGET host; reject other origin for settle |
| Garbage path | `${` in path → no settle |
| Purpose default | shell GET → test; browser nav → browse; seed → setup |
| TESTED | one test exchange → case_tested; browse-only → false |
| Dual-write | case_tested survives platform project |

---

## Out of Scope

- Noise UI chip or PRIOR chip.  
- Full FTP leaf aggregation.  
- Perfect intent detection for read-only security tests (use tool purpose=test).  
- Hard settlement block on untested NEW (soft only).  
- Changing Finding NEW semantics.

---

## Work tickets

| # | Deliverable |
|---|-------------|
| [#412](https://github.com/zangjiaao/my-ai-pen/issues/412) | Surface settle: scope + garbage path noise filter |
| [#413](https://github.com/zangjiaao/my-ai-pen/issues/413) | Traffic purpose + Surface TESTED from test traffic (≥1) |

**Frontier:** #412 first (or parallel with care). #413 consumes purpose + case_tested.

---

## Amendment checklist

- [x] Spec indexed in `docs/README.md`  
- [x] Cross-links from case-surface-ledger + surface-new-tested-coverage  
- [x] Scope + garbage settle gates — #412  
- [x] Traffic purpose + tool defaults — #413  
- [x] case_tested + operator TESTED projection — #413  
- [x] Harness/summary copy alignment — #413  
- [x] Tests (scope + garbage + static denylist + collapsed OS probe for #412; purpose/TESTED for #413)  
