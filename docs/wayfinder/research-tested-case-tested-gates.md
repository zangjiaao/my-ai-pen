# Research: current TESTED / case_tested / surface upsert / coverage gates

**Date:** 2026-08-22  
**Ticket:** wayfinder research [#505](https://github.com/zangjiaao/my-ai-pen/issues/505)  
**Map:** [#504](https://github.com/zangjiaao/my-ai-pen/issues/504) (Agent-maintained Surface TESTED; Traffic sitemap; Todo-class plan)  
**Scope:** Durable **facts** (not product decisions) for where product code and living Spec **read or write** operator **TESTED**, Surface `case_tested`, Traffic `purpose=test` settle, Agent `surface` upsert, and Graph / soft-harness **NEW→TESTED** duty.  
**Does not implement product code. Does not choose a product path.** Snapshot of tree at `9d55ba0` (`research/tested-case-tested-gates` branched from that HEAD).

**Related living docs (product truth, not this note’s authority to amend):**  
- `docs/specs/surface-new-tested-coverage.md` — v3 operator axes NEW · TESTED · finding tags; **L2 “No Agent upsert to fake TESTED”**  
- `docs/specs/surface-traffic-purpose-and-noise.md` — Traffic `purpose` + TESTED ≔ ≥1 `purpose=test`  
- `docs/specs/case-surface-ledger.md` — v2 settle / `surface` tool / Graph gates  
- `docs/specs/harness.md` §7 — soft NEW untested; product outer continue **OFF**  
- `docs/specs/task-graph.md` — Graph `todo(done)` surface-ledger gate (v1 vocab in that section)  
- `experts/pentest/work.md` — profession NEW→TESTED copy  

**Related tickets:** #406 / #407 (SEEN honesty) → #411 (NEW→TESTED + cannot-fake-TESTED); #412 noise; #413 purpose→`case_tested`; dual-write preserve PR #414. Job D map [#442](https://github.com/zangjiaao/my-ai-pen/issues/442) **cuts MITM auto-TESTED**.

---

## Question

Where does product code and living Spec today read or write **TESTED** / `case_tested` / `purpose=test` Surface settle, Agent `surface` upsert, and Graph or soft-harness **NEW→TESTED** duty?

Facts only: file paths, invariants (especially “No Agent upsert to fake TESTED”), and what would break if TESTED became Agent-maintained work state (Todo-class, not inferred from Traffic).

---

## Executive answer (facts)

| Seam | Writer today | Reader today | TESTED coupling |
|------|----------------|--------------|-----------------|
| Traffic `purpose` | Node classify (`traffic-purpose.ts`); stored on exchange | Settle + Traffic panel | **`purpose=test` is the only value that marks TESTED** (`purposeMarksCaseTested`) |
| Surface `case_tested` | Traffic settle with `allowCaseTested` only (sticky true) | FE chip, Agent summary, soft harness, dual-write | Operator TESTED **is** this flag after #413 |
| Internal `touched` | Traffic settle (`allowTested`); **not** Agent upsert | Graph `todo(done)` / `summary.actionable` | #411 treated `touched` as TESTED; #413 split chip off it |
| Agent `surface(upsert)` | Corrective only; **cannot** set booked; **cannot** set `case_tested`; requested `touched` capped to `seen` | Rare | Invariant: **no Agent upsert to fake TESTED** |
| TARGET seed | `seen` / `source=target_seed` | Ledger fill | **Does not** set `case_tested` |
| `finding(confirm)` book | `status=booked` (`allowBooked`) | Finding tags; Graph booked count | **Does not** set `case_tested` (orthogonal) |
| Soft NEW→TESTED harness | Runtime reminder copy only | Outer continue (`composeContinuePrompt`) | Product default **outer continue OFF** — reminders are lab-opt-in |
| Graph stage `surfaces_min` | Host projects **row count** from SQLite | `evaluateStageGate` | **Not** TESTED / not `case_tested` |
| Graph `todo(done)` | Agent `todo` + SQLite `actionable` (seen+touched) | Hard reject while open/in_probe remain | **Not** `case_tested`; still v2 status family |
| Profession | Pack `work.md` + tool description | LLM | Duty **NEW → TESTED via traffic**; upsert cannot fake |

**One-line:** Operator TESTED is a **Runtime-derived, sticky, Traffic-purpose flag** (`case_tested`). The Agent’s legal write for coverage is **generate test-purpose HTTP** (or `deadend` / `skipped_roe`). Agent upsert is gated so it **cannot** mint TESTED.

---

## 0. Living Spec locks (normative text)

### 0.1 Operator TESTED is purpose-derived (`case_tested`)

`docs/specs/surface-traffic-purpose-and-noise.md` **L4**:

```text
TESTED  ≔  this Case has ≥1 exchange with purpose=test on that identity
           (single test request is enough; re-verify old vulns counts)
未测    ≔  no test-purpose traffic this Case
```

L3 table: only `purpose=test` drives TESTED; `browse` / `setup` / `noise` / `unknown` do **not** (`unknown` fail-closed). Surface row stores derived **`case_tested`**. Findings / booked **do not define TESTED**. Upsert “still cannot fake TESTED without traffic.”

Companion v3 Spec `docs/specs/surface-new-tested-coverage.md` **L2**:

> **TESTED** advances only via **real Traffic** on that identity … **No Agent upsert to fake TESTED.**  
> Platform vuln history **must not** alone mark TESTED or remove NEW.

**L4** Agent duty: drive **NEW → TESTED** (or explicit `deadend` / `skipped_roe`); soft settlement (open NEW untested must not hard-block booking); honest pause must disclose remaining NEW untested (#406/#407 language extended).

**L6:** TESTED analogue is `case_tested` (≥1 `purpose=test` this Case), **not** multi-hit-only `touched`.

### 0.2 Two independent seams (noise vs purpose)

`surface-traffic-purpose-and-noise.md` **L1**: noise filter decides **which exchanges may create/update Surface**; purpose classification decides **which in-ledger exchanges mark TESTED**. No UI “noise” chip.

### 0.3 v2 ledger still births rows from Traffic + seed

`case-surface-ledger.md` **D0/D6/D8**: rows birth from Runtime Traffic settle + TARGET seed; Agent `surface` upsert is **non-primary**; booked only via finding confirm. **D5:** keep `upsert` registered; prompts must not require registration.

### 0.4 Map #504 destination vs current Spec (context only)

Map [#504](https://github.com/zangjiaao/my-ai-pen/issues/504) **destination** (not shipped): Case identities stay Traffic-born; **TESTED becomes Agent-maintained work state (Todo-class), not inferred from Traffic / MITM / `purpose=test`**. Job D map [#442](https://github.com/zangjiaao/my-ai-pen/issues/442) already **cuts MITM auto-TESTED**. That destination is **not** living Spec today. Living Spec is the opposite: TESTED **is** inferred from `purpose=test`.

---

## 1. Write path (who may set TESTED / `case_tested`)

### 1.1 Traffic `purpose` classification (Node)

`node4/src/runtime/traffic-purpose.ts`:

| Piece | Lines | Fact |
|-------|-------|------|
| Enum | 12–18 | `test \| browse \| setup \| noise \| unknown` |
| Tool-family default | 107–134 | `shell` / `http` / **`mitm`** / `session` → **`test`**; ordinary `browser` → `browse`; TARGET seed → `setup` |
| Classify order | 161–168, 170–218 | explicit purpose → noise heuristics (garbage / OOS) → family default → write-method / probe-path upgrade to `test` (not if family is `setup`) → else default or `unknown` |
| TESTED predicate | 245–249 | `purposeMarksCaseTested` is **true only for `test`** |

Callers attach purpose at collect time (`traffic-collect.ts` 70–74, 201–206, `ensureExchangePurpose` 915–935). `http` complete/fail always classifies then **awaits** Surface settle (540–572). Shell curl/wget/httpie and browser drains also settle (`grep` hits `settleTrafficToSurface` in the same file).

Platform Traffic store accepts optional `purpose` (`platform/backend/app/services/traffic_exchange.py` 20–21, 105–146). Traffic audit Spec (`docs/specs/traffic-audit-activity.md`) does **not** mention TESTED; job D is “same pipeline, new `source: mitm`” (lines 31, 39, 53).

**Fact:** `source: mitm` is already classified as **`test` by default** (`traffic-purpose.ts` 124). If job D hooked MITM exchanges into `settleTrafficToSurface` **without** a Spec change, they would **auto-set `case_tested`**. Map #442’s “cut MITM auto-TESTED” is a **destination lock against that default**, not a code exception today.

### 1.2 Traffic → Surface settle (`planTrafficSurfaceSettle`)

`node4/src/runtime/surface-settle.ts`:

| Piece | Lines | Fact |
|-------|-------|------|
| Skip gates (L2) | 306–331 | pending phase, empty/unparseable URL, non-HTTP, static suffix denylist, `${`/`{{` garbage, collapsed OS-probe, out-of-scope origin |
| Purpose | 337–346 | `classifyTrafficPurpose` then `purposeMarksCaseTested` |
| Internal status | 347–354 | `purpose=test` → **immediately `touched`**; non-test first hit → `seen`; later non-test → `touched` (Graph bookkeeping) |
| `case_tested` on plan | 88–91, 355 | `true` iff this exchange is test-purpose; comment: false means “do not set” (never clears) |
| Apply | 427–449 | `store.upsert` with `source: "traffic"`, `allowTested: true`, **`allowCaseTested: plan.case_tested`**, item `case_tested: true` only when plan says so |

**Fact:** a **single** in-scope `http`/`shell` GET (family default `test`) is enough to set both internal `touched` and operator `case_tested`. A **browser** document GET (family `browse`) first-settles `seen` with `case_tested=false`; a second browse on the same identity becomes internal `touched` **without** TESTED.

### 1.3 SQLite working store (Node SoT for Agent + Graph)

`node4/src/stores/surface-sqlite.ts`:

- Column `case_tested INTEGER NOT NULL DEFAULT 0` (224, migrated 381–382). **No `is_new` column** (grep on this file is empty).
- `SurfaceUpsertMeta.allowTested` (104–109): “Allow status=`touched` (operator TESTED). Traffic settle only (#411). Ordinary Agent upsert leaves this false.”
- `allowCaseTested` (110–114): “allow setting `case_tested=true` (purpose=test traffic only).”
- Upsert (585–624):
  - `allowTested` true if `meta.allowTested` **or** `meta.source === "traffic"` **or** **item `source === "traffic"`**.
  - `case_tested` becomes true **only** when `allowCaseTested && raw.case_tested`; otherwise sticky existing true, else false.
- `summary()` (845–873): maps `seen`→`open`, `touched`→`in_probe`; **`actionable = seen + touched`**. Does **not** read `case_tested`.
- `markBooked` (979–1016): `allowBooked: true`; create-on-book `source=finding`; **does not pass `case_tested` or `allowCaseTested`**.
- `upsertFromRecon` (1030–1067): host inject / recon merge as `status=seen`, `source=agent|import`; no TESTED flags.

Identity helper `node4/src/stores/surface-identity.ts` 15, 523–556: `resolveUpsertStatus` **caps requested `touched` to `seen` unless `allowTested`**. Header comment: “ordinary upsert cannot elevate to touched/TESTED without allowTested.”

**Hole (status only, not chip):** if an Agent upsert item sets `source: "traffic"`, SQLite treats `allowTested` true (588–589) and **can** write internal `touched`. `case_tested` still requires `allowCaseTested`. The Agent tool schema **does** expose `source` (`surface.ts` 102, 117) and `asItemList` copies it (47, 62). Tests that “cannot fake TESTED” (`surface.test.ts` 91–110) omit `source: "traffic"` and assert status stays `seen`. Operator chip after #413 follows `case_tested`, not `touched`.

### 1.4 Agent `surface` tool

`node4/src/tools/surface.ts`:

- Description (74–86, 111): primary `summary|list|get`; TESTED only via purpose=test Traffic; **“cannot fake TESTED/case_tested without traffic”**; upsert statuses `seen|deadend|skipped_roe` (not booked; touched/TESTED only via Traffic).
- `asItemList` (35–64): copies location/methods/params/status/kind/auth/note/**source** — **not** `case_tested`.
- `op=upsert` (257–276): `store.upsert(..., { source: "agent" })` — no `allowTested` / `allowCaseTested`.
- `op=summary` (143–215): `tested` / `case_tested` counts = rows with `case_tested === true`; `new_untested` from `selectNewUntestedSurfaces`; guidance restates NEW→TESTED + cannot-fake.
- `depositSurfaceLocation` (317–381): `fact(op=surface)` helper; same `source: "agent"` upsert. `docs/specs/owner-intel.md` notes `fact(op=surface)` **removed** as attack-surface write (201).

Tests: `node4/src/tools/surface.test.ts` 91–157 (cannot elevate `touched`; cannot invent `case_tested`; traffic-meta path can).

**Fact:** Agent **can** write terminals `deadend` / `skipped_roe` via ordinary upsert (`resolveUpsertStatus` allows those ranks). Those are already Agent-maintained work-state writes. TESTED is not.

### 1.5 TARGET seed

`node4/src/runtime/surface-target-seed.ts` 1–6, 145–163: web origins as `status: "seen"`, `source: "target_seed"`; **no** `allowTested` / `allowCaseTested`. Called at Free session start (`session-runner.ts` ~301) and Hard Graph task start (`hard-graph-task.ts` ~325).

Spec: `case-surface-ledger.md` D8 — seeds are `seen` until traffic advances them. Purpose default for seed is `setup` (`traffic-purpose.ts` 120, 132), which does **not** mark TESTED.

### 1.6 Finding confirm → booked (orthogonal)

Node: `finding.ts` 607–622 → `surfaceSqlite.markBooked` (no `case_tested`).  
Platform: `surface_ledger.py` `apply_booked_side_effect` (1061–1177) merges `status: "booked"` with `allow_booked=True`. Merge docstring (732–735): **“Finding book alone does not set `case_tested`.”** Incoming booked dict omits the flag → coerce false; sticky OR keeps a prior true. WS side-effect: `ws/router.py` 1555–1559, 3258–3376 (+ inventory `is_new` stamp).

v3 Spec L1: findings are **tags**, not TESTED. Purpose Spec L4: same; optional “narrow exception” to set `case_tested` on book **is not implemented**.

### 1.7 Dual-write Node → Case ledger

`node4/src/runtime/surface-platform-sync.ts` 41–55: payload includes `case_tested: row.case_tested === true`. **Does not send `is_new`.**

Platform persist: `ws/router.py` `_persist_surface_upsert` 3172–3252 — `allow_booked=False`; inventory admit stamps `is_new`; merge into `conversation.context["surface_ledger"]`; optional owner-ledger HTTP attach.

`surface_ledger.py`:

- `normalize_surface_row` 671–694: false-safe `case_tested`.
- `merge_surface_row` 732–801: **sticky true** (`prev OR incoming`); never clears.
- Tests: `platform/backend/tests/test_surface_ledger.py` 256–314 — later dual-write with `case_tested: False` **must not** clear sticky true.

**Fact:** Platform ordinary `resolve_upsert_status` (529–550) **has no `allowTested`**. It will persist `touched` if Node sends it. The TESTED **chip** gate is Node `allowCaseTested` + sticky merge of the boolean, not a second Platform status cap.

Owner ledger **does not store** `case_tested` / `is_new` (`tests/test_owner_ledger.py` 388–396).

### 1.8 Inventory NEW (`is_new`) — Platform only

`surface-new-tested-coverage.md` Implementation 3: first durable-inventory admit → Case row `is_new=true` (sticky for the engagement). Case ledger remains TESTED/traffic SoT.

Node SQLite **has no `is_new`**. Agent `summary` / soft harness therefore run `selectNewUntestedSurfaces` in **`seen_fallback` mode** whenever no row carries `is_new` — i.e. **all `!case_tested` identities**, not inventory-NEW-only (`surface-harness.ts` 53–70; `surface.test.ts` 217–226 expects `new_untested_mode === "seen_fallback"`).

---

## 2. Read path (who consumes TESTED / coverage)

### 2.1 Operator UI (Case Surface tab)

| File | Behavior |
|------|----------|
| `platform/frontend/src/lib/surfaceModel.ts` `surfaceStatusLabel` 127–158 | `caseTested true` → `"TESTED"`; explicit false → no chip (even if `status=touched`); **legacy** (flag omitted) → `touched` family still labels TESTED |
| `isSurfaceCaseTested` 103–115 | false-safe |
| Live merge 305–319 / project 357–358, 440–447 | sticky true |
| `SurfaceTreeView.tsx` chrome 73, 107–114, 868–888 | TESTED chip from `case_tested`; never SEEN/BOOK/PRIOR |
| View filter 610–611, 642 | `untested` = `caseTested !== true` (seed `/` counts as untested until a test-purpose hit) |
| `toolDetail.ts` 60–62 | Chat tool card: `tested ?? case_tested` from `surface(summary)` |

Tests: `surfaceModel.ledger.test.ts` 101–106, 202–289 (browse multi-hit + `case_tested: false` → no TESTED chip).

### 2.2 Soft harness NEW → TESTED (#411 / #413)

`node4/src/runtime/surface-harness.ts`:

- Queue: prefer `is_new && !case_tested`; else all `!case_tested`. Legacy rows **without** the flag treat `touched`/`booked` as tested (37–41).
- Stop reminder (74–94): “need purpose=test traffic / `case_tested`”; “Duty: NEW → TESTED via real test-purpose traffic … Runtime sets `case_tested`”; “never blocks booking or settlement.”
- Mid-run nudge (98–107): same vocabulary.

Wired only through **outer continue**:

- `session-runner.ts` 790–838 reads SQLite `all()`, `selectNewUntestedSurfaces`, passes counts into `composeContinuePrompt`.
- `loop-policy.ts` 437–454: empty/premature → stop reminder; other continue kinds → mid-run nudge.

**Product default outer continue is OFF** (`harness.md` §3 line 60; `loop-policy.ts` 64–87: `NODE4_MAX_CONTINUES` default **0**). So on product seats, the #411/#407 **inject does not fire** unless lab sets `NODE4_MAX_*`. Remaining product-path honesty for Free is **profession + `surface(summary)` guidance when the Agent calls it**.

`docs/specs/harness.md` §7 (236): “Surface NEW untested (soft) … **never** blocks settlement.”

### 2.3 Graph gates (do **not** read `case_tested`)

| Gate | Code | What it measures |
|------|------|------------------|
| Stage `surfaces_min` | `hard-graph-runner.ts` `evaluateStageGate` 262–267 | `structured.surfaces.length` |
| Host projection of those surfaces | `host-stage-settlement.ts` `surfacesFromWorkingStore` 117–129 | **All** SQLite rows (cap 80), mapped to `{location,kind,params,auth,note}` — **no status / no `case_tested`** |
| Host inject deposit | `hard-graph-stage-executor.ts` 116–122 | `upsertFromRecon` → `seen` only |
| Stage prompt (non-subagent) | same file 192 | “explore so Traffic settles into Surface; `surface(summary\|list)` for coverage” — **does not say TESTED / `case_tested`** |
| Graph `todo(done)` | `todo.ts` 72–100; `surface-ledger.ts` `assertTodoDoneAllowed` 341–433 | If SQLite `summary.total ≥ 1` and `actionable ≥ 1` (**seen+touched**), reject unless `note=deadend\|skipped_roe` or acted path match. Error text still says **“open/in_probe”**. Graph-only (`pentestGraph.mode === "graph"`). Free is not this gate. |
| Route / process metrics | `hard-graph-stage-executor.ts` 615–628, 675–678 | `surfaceSummary.total` / open+probed — **counts**, not TESTED |

`docs/specs/task-graph.md` “Surface ledger (coverage truth)” (96–104) still documents **v1** status `open → in_probe → probed` and Graph `todo(done)` blocked while open/in_probe remain. `case-surface-ledger.md` D11: gates may read Surface; prefer not to force manual surface ops. v3 Spec implementation 6: keep host-owned package/surface gates; map booked/open internally without BOOK chip.

**Fact:** Graph **structure** gate (`surfaces_min: 1`) can pass on **TARGET seed alone** (seed writes `seen` rows before any traffic). Graph **todo honesty** treats `touched` (including browse multi-hit **or** a single test-purpose hit) as “acted.” Neither gate is the operator TESTED chip.

### 2.4 Profession / standing prompt copy

| Source | What it says | Drift vs #413 code |
|--------|----------------|---------------------|
| `experts/pentest/work.md` 38 | Duty NEW → TESTED **“(this-Case further traffic; internal `touched`)”**; upsert cannot fake TESTED; disclose remaining NEW untested; never hard-blocks | Equates TESTED with **`touched`**, not `case_tested`. Tests in `prompt-layers.test.ts` 485–513 lock the NEW→TESTED / cannot-fake / disclose markers, not the touched synonym. |
| `prompt-layers.ts` 374–377 | `seen=first-touch still owed deepen; touched=further traffic`; “disclose remaining **seen**” | Pre-#411/#413 SEEN vocabulary; **does not mention `case_tested`**. |
| Surface tool description | TESTED = `case_tested` from purpose=test | Aligned with #413. |

### 2.5 Other readers

- `CONTEXT.md` ~148: owner-ledger paths ≠ Case Surface NEW/TESTED.
- `docs/prd.md`: no `TESTED` / `case_tested` hits (operator Surface v3 lives in the Surface Specs).

---

## 3. Invariant: “No Agent upsert to fake TESTED”

Shipped as **two stacked gates** (status then flag):

1. **#411 (status):** Agent cannot advance to `touched` without `allowTested` / traffic source (`surface-identity.ts` 553–556; `surface-sqlite.ts` 585–590; `surface.test.ts` 91–110; `surface-identity.test.ts` 242+). Living Spec L2 / Implementation 5: “Upsert: Must not elevate TESTED rank without traffic.” At #411 time, TESTED **was** that rank (`touched`).
2. **#413 (flag):** Agent cannot set `case_tested` without `allowCaseTested` (`surface-sqlite.ts` 618–624; `surface.test.ts` 149–157). Operator chip and summary `tested` follow the flag. Purpose Spec L5: “Upsert still cannot fake TESTED without traffic.”

**Still Agent-writable (not TESTED):** `seen`, `deadend`, `skipped_roe`, notes, methods/params merge. **Never Agent-writable:** `booked` (confirm path only).

Contract tests that would fail if Agent could stamp TESTED: `surface.test.ts`, `surface-identity.test.ts`, `surface-harness.test.ts`, `prompt-layers.test.ts` (work.md “cannot fake TESTED”), `surfaceModel.ledger.test.ts` (browse `touched` + `case_tested: false` quiet), `test_surface_ledger.py` (sticky dual-write), v3 Spec checklist “upsert cannot fake TESTED” (`surface-new-tested-coverage.md` 180).

---

## 4. Three queues that are already not the same axis

| Queue | Predicate today | Used by |
|-------|-----------------|---------|
| **Operator TESTED / 未测** | `case_tested === true` / else | FE chip + untested filter |
| **Agent / soft “NEW untested”** | `is_new && !case_tested` if any `is_new` present; else **all `!case_tested`** (Node SQLite has no `is_new` → always this fallback) | `surface(summary)`, lab outer-continue reminders |
| **Graph actionable** | `status ∈ {seen, touched}` (`summary.actionable`) | Graph `todo(done)` hard gate |

Consequences already visible in code (not a recommendation):

- Browser multi-hit: Graph may treat the path as acted (`touched`); operator still 未测.
- Single `http` GET: operator TESTED **and** Graph `touched` together (family default `test`).
- Seed `/`: Graph `surfaces_min` can pass; operator untested; Agent fallback queue includes it until a test-purpose hit.
- Booked without prior test traffic (create-on-book): Graph booked (not actionable); operator still 未测 unless traffic already set the flag.

---

## 5. Living Spec vs code (factual drift)

| Claim in a living doc | Code today |
|------------------------|------------|
| `task-graph.md` surface statuses `open → in_probe → probed` | Write vocab is `seen → touched → booked` (+ terminals); gates map seen→open, touched→in_probe (`surface-sqlite.ts` 169–173, 860–868) |
| `work.md` TESTED = internal `touched` | Operator TESTED = `case_tested`; `touched` can be browse multi-hit |
| `prompt-layers.ts` “disclose remaining seen” | Tool + harness speak **NEW untested / `case_tested`** |
| v3 L4 “soft settlement … honest pause” via #407 harness | Reminder **code** exists; **product default does not run outer continue** |
| Purpose Spec L4 optional book→`case_tested` exception | **Not implemented** |
| v3 “prefer `is_new` when present” for Agent queue | True in the selector; **Node rows never have `is_new`**, so Agent queue is all untested identities |
| `traffic-purpose.ts` `mitm` → default `test` | Conflicts with map #442 destination “cut MITM auto-TESTED” if settle is wired later without a purpose override |

---

## 6. Implications for Spec authors (not decisions)

If map #504’s destination shipped — **TESTED is Agent-maintained work state (Todo-class), not inferred from Traffic / MITM / `purpose=test`** — the following are **coupling facts** a later Spec would have to name. This section does **not** choose among them.

### 6.1 Writer inversion

Today the Agent **must not** write TESTED; Runtime **must** write it from `purpose=test`. Todo-class TESTED **inverts** L2 (“No Agent upsert to fake TESTED”), purpose L4/L5, `allowCaseTested`, surface tool schema (no write field), `work.md` “cannot fake,” and the #411/#413 tests listed in §3.

A new Agent write (amend `surface` vs Todo vs new verb — map fog) would be the **first** product path that sets operator TESTED without Traffic. Closest existing analogue is Agent `deadend` / `skipped_roe` upsert (already allowed, Graph-todo accepted via `note=`).

### 6.2 What would keep working vs what would lie

**Identities / sitemap (Traffic-born)** could stay: settle, seed, noise filter, dual-write, FE tree. Map #504 keeps that.

**If `purpose=test` settle still set `case_tested`:** MITM job D, every `http`/`shell` GET, and session acts would **keep auto-TESTED** (`mitm`/`http`/`shell` family default `test`). That **is** the auto-TESTED #442 already cut for MITM, and the current definition of the chip.

**If settle stopped setting `case_tested` but still set `touched`:** Graph `todo(done)` and `summary.actionable` would still advance on traffic; operator TESTED would wait for Agent mark; FE untested filter would stay full until Agent writes. Browse vs test distinction would **stop mattering** for the chip.

**If both `touched` and `case_tested` became Agent-only:** Graph todo gate would no longer move on real requests unless the Agent also upserted status (today they **cannot** upsert `touched`). `surfaces_min` would still pass on seed/settle **row existence**.

### 6.3 Sticky true / Case scope / Park

`case_tested` is **Case-scoped** (Node `workspace/case-{id}/surfaces/ledger.sqlite` + `conversation.context["surface_ledger"]`), dual-written, **sticky true** (Node + Platform + FE live merge). Map fog already asks: persist across Park/Reset? per Participant Session vs Case-shared? Today it is **Case-shared**, not per-seat. Todo-class per-seat TESTED has **no** current column.

Un-TESTED is **impossible** once true (no Agent or settle clear). Todo-class “undo” would need a new write rule.

Seed-only `/` with no HTTP: Agent **cannot** mark TESTED today; map fog asks whether that should become allowed.

### 6.4 Harness / profession copy that assumes Runtime sets the flag

Would go stale unless rewritten: `surface-harness.ts` 90–91 (“Runtime sets `case_tested`”), `surface.ts` guidance 214, `work.md` 38, v3 L4, purpose L5, `harness.md` §7. Graph stage footer (“explore so Traffic settles”) would no longer be the TESTED mechanism even if it remained the **row-birth** mechanism.

Product Free still would not get #411 injects unless outer continue is turned on — independent of who writes TESTED.

### 6.5 Dual writers / MITM

Leaving `purpose=test` settle **and** adding Agent TESTED creates two writers and the existing sticky-OR merge (first true wins). Cutting settle-from-purpose while MITM still defaults `purpose=test` is consistent with #442 **only if** TESTED no longer reads purpose. Traffic panel could still show `purpose` as audit.

### 6.6 Tests / contracts that encode Traffic-objective TESTED

Any Spec that redefines TESTED as Agent work state would invalidate (as product contracts, not as history): `traffic-purpose.test.ts`, `surface-settle.test.ts` purpose cases, `surface.test.ts` 125–226, `surface-harness.test.ts` 36–70, `test_surface_ledger.py` 256+, `test_surface_inventory.py` “inventory age does not invent TESTED,” `surfaceModel.ledger.test.ts` 106, 287–289, v3 testing table “Settle: second traffic → TESTED projection.”

---

## Sources (tree)

| Path | Role |
|------|------|
| `docs/specs/surface-new-tested-coverage.md` | v3 NEW/TESTED/tags; L2 no-fake-TESTED; L4 duty |
| `docs/specs/surface-traffic-purpose-and-noise.md` | purpose enum; L4 formula; L5 upsert |
| `docs/specs/case-surface-ledger.md` | v2 settle + tool + D11 gates |
| `docs/specs/harness.md` | soft NEW untested; outer continue OFF |
| `docs/specs/task-graph.md` | Graph todo surface gate (legacy vocab) |
| `docs/specs/traffic-audit-activity.md` | Traffic collect; job D `source: mitm` reserved |
| `experts/pentest/work.md` | Profession NEW→TESTED |
| `node4/src/runtime/traffic-purpose.ts` | classify + `purposeMarksCaseTested` |
| `node4/src/runtime/traffic-collect.ts` | purpose on emit + settle on complete |
| `node4/src/runtime/surface-settle.ts` | `planTrafficSurfaceSettle` / `allowCaseTested` |
| `node4/src/runtime/surface-target-seed.ts` | seed `seen` |
| `node4/src/runtime/surface-harness.ts` | NEW untested reminders |
| `node4/src/runtime/surface-platform-sync.ts` | dual-write `case_tested` |
| `node4/src/runtime/loop-policy.ts` / `session-runner.ts` | continue inject (lab) |
| `node4/src/runtime/hard-graph-runner.ts` / `host-stage-settlement.ts` / `hard-graph-stage-executor.ts` | Graph gates |
| `node4/src/stores/surface-sqlite.ts` / `surface-identity.ts` / `surface-ledger.ts` | upsert gates + Graph todo |
| `node4/src/tools/surface.ts` / `todo.ts` / `finding.ts` | Agent + book side-effect |
| `platform/backend/app/services/surface_ledger.py` | Case merge sticky `case_tested` |
| `platform/backend/app/ws/router.py` | `surface_upsert` persist + book side-effect |
| `platform/frontend/src/lib/surfaceModel.ts` / `components/SurfaceTreeView.tsx` | TESTED chip + untested filter |
