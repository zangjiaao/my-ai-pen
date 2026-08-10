# Spec: Case Surface ledger (shared attack-surface SoT)

**Status:** amended (product model v2 — Agent-first passive management)  
**Issue:** [#368](https://github.com/zangjiaao/my-ai-pen/issues/368)  
**Related:** Product state → UI passive projection ([#280](https://github.com/zangjiaao/my-ai-pen/issues/280)); Case traffic audit ([#309](https://github.com/zangjiaao/my-ai-pen/issues/309)); base booking / finding id ([#279](https://github.com/zangjiaao/my-ai-pen/issues/279)); task-graph ([`task-graph.md`](task-graph.md)); Asset inventory ([#322](https://github.com/zangjiaao/my-ai-pen/issues/322)); ADR 0001 Graph × Pi

**Product path:** Node4 Agent Runtime (Traffic collect → Surface settle + SQLite working store) · Platform Case `surface_ledger` + WS · Conversation right-panel Surface tab  

**Does not implement product code in this document** — normative contracts only.

**Decision history:**

| When | What |
|------|------|
| 2026-08-10 | v1 grill: Agent deposit via `surface` tool; Traffic raw material only; no TARGET seed |
| 2026-08-10 | v1 implementation tickets #369–#378 (tool, SQLite, dual-write, FE, finding→booked, import, traffic_list) |
| 2026-08-10 | Field failure: Case finished with Findings + Traffic, Surface empty; Agent recon = prior path lists + curl, not scientific crawl; finding→booked failed on non-URL `location` |
| 2026-08-10 | **v2 grill (this amendment):** Surface is **Agent working memory**, **Runtime-passive from Traffic**, completion via **finding confirm**; no complete-tag without test traffic |
| 2026-08-10 | **v3 operator model (amend):** [`surface-new-tested-coverage.md`](surface-new-tested-coverage.md) — UI **NEW** (inventory novelty) + **TESTED** (this-Case traffic) + finding tags; no BOOK/SEEN/PRIOR chips; method chips off tree; priors ≠ coverage. Internal settle may keep seen/touched/booked expand–contract. |

---

## Problem Statement

### Operator / Agent experience

- Surface tab empty while Traffic and Findings grow → operators lose trust; process looks broken.
- Agents focus on **booking vulns**, not ledger hygiene. Requiring deliberate `surface.upsert` (v1) fails in the field: Agents skip it; more gates steal attention without fixing behavior.
- Agents often **guess known product paths** (e.g. Juice Shop menus) and batch-`curl`, without browser crawl, OpenAPI parse, or traffic-driven discovery. That is **not** scientific black-box recon for unknown systems—even when it “works” on famous labs.

### Product intent (v2)

**Surface management exists to help the Agent know what was found, what was touched, and what was completed—not to give the Agent another administrative chore.**

```text
Agent explores (guess OK if real requests; prefer real feature use)
  → real traffic
  → Runtime settles Traffic into Surface (passive)
  → Agent reads Surface summaries (how many / what’s left)
  → finding(confirm) marks matching Surface complete (booked)
  → forbid completion tags on surfaces with no test traffic
```

UI projects the **same** Case ledger. Dual-write (Node SQLite + Platform) remains the storage topology from v1 implementation.

---

## Solution

### End-to-end flow (normative v2)

```text
TARGET seed (engagement)
        +
Agent acts (shell/http/browser/…) — may guess paths; must generate real requests
        │
        ▼
Traffic exchanges (#309)          ← L0 raw capture (unchanged collect)
        │
        ▼  Runtime settle (passive, continuous)
Surface ledger (Case + Node SQLite)
  seen    = first observation for identity
  touched = subsequent request activity on identity
  booked  = finding(confirm) success on that identity
        │
        ├─► Agent read-only summary / list (management view)
        ├─► Operator UI Surface tab (project only)
        └─► finding(confirm) → complete tag (booked); no traffic ⇒ no complete
```

### Roles (v2)

| Role | Responsibility |
|------|----------------|
| **Agent** | Explore and test (guess + real use OK); **read** Surface to manage work; **confirm** findings (drives booked). Does **not** own “register every path” as a primary task. Must **not** mark complete without traffic evidence. |
| **Node Runtime** | Collect Traffic; **settle** Traffic (+ TARGET seed) into Surface; dual-write Platform; apply booked on confirm; enforce no-complete-without-traffic; optional short Surface summary into Agent context |
| **Platform** | Case `surface_ledger` SoT for UI/import; WS `surface_upsert`; booked side-effect on `vuln_found` |
| **Frontend** | Project Case ledger only; honest empty when empty |

### Primary audience

**First service object = Agent working memory.** Operator UI and Graph metrics are the same ledger’s projections, not a separate “human-only” list.

### What is *not* Surface

- Raw Traffic exchange bodies (Traffic tab owns those)
- Global asset `urls` bags
- Chat prose claiming “discovered surfaces” without ledger rows
- Completion tags without test traffic on that identity

### Scientific discovery (product pressure, not this Spec’s full recon engine)

v2 **does not** ban path guessing. It requires:

1. Guesses that matter **leave Traffic** (real requests).  
2. Runtime **records** those as Surface.  
3. Later work (separate tickets / harness) should **encourage** contract crawl, HTML/JS extract, authenticated browsing—so discovery is not *only* prior menus.  

Surface Spec owns **settle + manage**; full “recon pipeline” skills may live in harness/pack tickets.

---

## User Stories

### Agent-first management

1. As an **Agent**, I want surfaces to appear when I generate real traffic, so that I do not spend turns on ledger bookkeeping.
2. As an **Agent**, I want a short summary (seen / touched / booked counts + samples), so that I know how much surface I have and how much is done.
3. As an **Agent**, I want `surface list` to page and filter the ledger, so that I can inspect without loading thousands of rows.
4. As an **Agent**, I want guessing paths to be allowed if I actually request them, so that prior knowledge can still produce ledger rows via Traffic.
5. As an **Agent**, I want successful `finding(confirm)` to mark the related surface complete, so that I do not double-update status.
6. As an **Agent**, I want the runtime to **reject** complete-tags on surfaces with no test traffic, so that I cannot fake coverage.
7. As an **Agent**, I may verify prior vulns early, so that those requests still populate Surface via Traffic before or after book.

### Operator / platform

8. As an **operator**, I want Surface to grow as traffic accrues, so that mid-run empty panel is rare when the Agent is active.
9. As an **operator**, I want Surface and Findings to align after books (booked surfaces), so that “vulns without surfaces” is not the normal end state.
10. As an **operator**, I want Surface to stay Case-scoped and not pull dirty global asset URL bags.
11. As an **operator**, I want multi-protocol origins (`scheme://host:port`) when non-HTTP traffic exists (later intensity OK).
12. As **Platform**, I want dual-write and snapshot/WS continuity from v1 implementation, so that FE projection stays event-driven.

### Integrity

13. As a **process owner**, I want chat claims of “discovered surfaces” to be checkable against the ledger, so that prose is not the SoT.
14. As a **security engineer**, I want identity without query strings as keys, so that parameterized probes do not explode the ledger.
15. As an **implementer**, I want hard-cap 2000 and read page 200 retained, so that context and storage stay bounded.

---

## Implementation Decisions

### D0 — Amendment supersedes v1 deposit model

| Topic | v1 (superseded for product) | v2 (normative now) |
|-------|----------------------------|--------------------|
| Who creates rows | Agent `surface` upsert primary | **Runtime settle from Traffic** (+ TARGET seed) |
| Traffic | Raw material only; no auto insert | **Primary feed into Surface** |
| TARGET seed | Forbidden | **Required** on engagement start |
| Completion | booked via finding; Agent upsert open | **booked only via finding confirm**; **no complete without traffic** |
| Agent `surface` tool | Primary deposit | **Read/list/get primary**; optional note; upsert not required for normal path |
| Empty mid-run with heavy traffic | “Honest empty” if no deposit | **Bug / incomplete settle** — not acceptable product outcome |

v1 code paths (SQLite, dual-write, FE projection, import, identity pure) **remain building blocks**; product rules above redirect **how rows are born and completed**.

### D1 — Product SoT vs working store (unchanged topology)

- **UI / Case SoT:** `conversation.context["surface_ledger"]` on Platform.
- **Agent / Runtime working store:** Node **SQLite** (`taskDir/surfaces/ledger.sqlite`).
- Online: dual-write; local commit required for Agent-visible local reads; Platform async (`platform_sync`).
- Offline: local only; import elevates to Case.

### D2 — Identity (two-level, unchanged)

- **Origin key:** normalized `scheme://host:port` (explicit ports, lowercased scheme/host).
- **Row key:** `origin_key` + `path_key` (HTTP path normalized; strip query/fragment; non-HTTP path empty).
- **Not in key:** method, query, JSON body fields (merge into `methods[]` / `params[]`).
- Future assets may align host inventory to origin; out of this Spec’s table migration.

### D3 — Status machine (v2)

Minimal normative statuses for management:

```text
seen  →  touched  →  booked
```

| Status | Meaning | Writer |
|--------|---------|--------|
| **seen** | Identity first observed (TARGET seed or first traffic settle) | Runtime |
| **touched** | Further request activity on that identity (or first request if policy collapses seen→touched on any request) | Runtime |
| **booked** | Successful finding confirm mapped to this identity | Runtime (book path only) |

**Rules:**

- Never downgrade (e.g. booked ↛ seen).
- **No Agent API may set booked/complete** except via finding confirm path.
- **Complete/booked requires** the identity to have had **test traffic** (`touched` or equivalent evidence). If confirm maps to a never-seen path, Runtime may **create** a row from resolved URL **only if** traffic or resolvable absolute URL evidence exists; otherwise soft-fail complete tag (finding still succeeds) — prefer resolving host+port+`location_key` from booking payload + recent traffic.
- Legacy statuses (`open` / `in_probe` / `probed` / `deadend` / `skipped_roe`) from v1 JSON/SQLite — **expand-contract** (#379): accept on read; normalize on write.

  | Legacy (read) | Write (v2) |
  |---------------|------------|
  | `open` | `seen` |
  | `in_probe` | `touched` |
  | `probed` | `touched` |
  | `booked` | `booked` |
  | `deadend` | `deadend` (optional terminal retained; same rank as `touched`, no lateral) |
  | `skipped_roe` | `skipped_roe` (optional terminal retained; same rank as `touched`, no lateral) |

  **Choice (#379):** `deadend` / `skipped_roe` are **retained as optional write terminals**, not collapsed to `touched`+tag.

**Optional later (not v2 DoD):** Agent `tested` without vuln — only if traffic touched; deferred so complete ≈ booked for now.

### D4 — Scope and caps (retained)

- Case-level cumulative ledger.
- Agent read page default **200**; `returned` / `total_matching` / `has_more`.
- Write hard-cap **2000** per Case (configurable ≤5000).
- Settle must be bounded (dedupe by identity; noise filters — see open knobs).

### D5 — `surface` tool (role change)

**Primary:** `list` / `get` / **summary** for Agent management (counts + samples). **Agent context injection:** tool-first (locked)—do **not** auto-inject a Surface summary every LLM turn; optional light prompt nudge (“use surface summary/list for coverage”) is OK.

**Secondary (optional):** `note` or rare manual correctives — not the main fill path.

**Deprecated as product requirement:** Agent must call `upsert` to make Surface real. **Locked:** keep `upsert` registered for debug/correction/import/tests, but **not** the primary fill path; prompts must not require registration. Normal engagement fill is settle-from-traffic (+ seed + confirm).

### D6 — Traffic settle → Surface (core v2)

- On Traffic exchange **complete**: **immediately** settle (normalize URL → identity → upsert Surface). No debounce/batch required for v2 (locked). Pending-only exchanges need not create rows until complete/fail with a usable URL.
- **v2 settle scope (locked): HTTP(S) only.** Non-HTTP origins remain valid identity types for later; do not block v2 DoD on ssh/redis capture.
- First time → `seen` (or `touched` if product collapses).
- Later requests on same identity → `touched`; merge methods.
- TARGET / scope.allow: seed origin (+ entry path `/` when web) at task start as `seen`.
- Agent exploration (guessed paths, feature clicking) **must** produce traffic to enter the ledger—by design.
- `traffic_list` remains available for raw capture inspection (#378); Surface is the **structured** management view.

#### D6.1 — Noise filter (locked)

**Request-as-row (Traffic settle → Surface):**

- Default: almost all http(s) exchanges with a path become/update a Surface row.
- **Static suffix denylist** — do **not** create Surface rows for the asset path itself, e.g. `.js`, `.css`, `.map`, common image/font extensions (exact list is an implementation knob; keep conservative).
- **4xx/5xx remain rows** (401/403/500 are valid surface signals). Optional config may drop pure connection-fail `000` later.

**Status vocabulary (locked):** keep **`seen` / `touched` / `booked`** (not collapsed). First observation → `seen`; later real request on same identity → `touched`; finding confirm → `booked`.

#### D6.2 — Capture enrichment / clue mining (follow-on to #309; not Surface v2 DoD)

**Placement:** After **capture** (Traffic), Runtime may run **enrichment** that mines valuable clues from stored exchanges (and response bodies)—especially SPA/Vue/React **JS bundles**, headers, and error pages—and **surfaces those clues to the Agent for analysis**.

This is a **Capture-layer capability** (extends #309 lineage), not a second Surface SoT and not required for the first Traffic→Surface settle ticket.

| Output | Destination |
|--------|-------------|
| Structured **clues** (API path candidates, internal hosts, secret-shaped strings, …) | Agent-readable channel: e.g. `traffic`/`capture` clue list tool, optional context hint, process facts |
| Optional later bridge | Selected path-shaped clues **may** be settled into Surface as `seen` + `source=js_extract` **only** when product chooses that bridge; clue stream itself must not explode Surface without budget |

**Plugin shape (preferred architecture, implement later):**

- Pluggable analyzers: `analyze_capture_artifact(kind, bytes, meta) → clues[]` (browser-load and offline `.js` fetch share the same interface).
- Inspired by browser “endpoint / secret finder” extensions, but **product-whitelisted** in pen-sandbox—not arbitrary store installs.
- Budgeted: max body bytes, max clues per artifact, severity tiers (endpoint vs credential).

**Relation to Surface management (v2):**

- Surface ledger remains **Traffic request settle + seed + confirm** for “what was hit / completed.”
- Clue mining helps the Agent **decide what to hit next** scientifically (read clues → request → settle → touch).
- Guesses that never become requests still do not become completed surfaces.

### D7 — Finding confirm → complete (booked)

On successful Case booking:

1. Resolve identity from absolute URL if present; else **host/target + port + location_key**; else URL extracted from proof excerpts.
2. **Create-on-book (locked):** If the identity was never trafficked, **still create/update a `booked` row** when resolution is **strong** (absolute URL and/or host+port+`location_key` composable). This is the completion tag path for confirm.
3. Set status `booked` (complete tag). Prefer attaching `last_traffic_at` when traffic exists; booked-without-prior-traffic is allowed only with strong identity evidence (not free-text prose alone).
4. Hard-cap: never fail finding; skip surface create with metric.
5. **Forbidden:** complete/booked without confirm; complete/booked when identity **cannot** be resolved to a strong location (no scheme-less bare guess, no empty host). Soft-fail surface side-effect; finding still succeeds.

**Known bug to fix under this Spec:** `location` like `PUT /api/Products/...` without scheme must not yield silent `unparseable` when `location_key` + host + port exist.

### D8 — TARGET seed (v2)

- Engagement target and in-scope allows **are** seeded into Surface at task start (origin + web root when applicable).
- Seeds are `seen` until traffic advances them.

### D9 — Document shape

```text
surface_ledger: {
  version: 2,                 // bump when status vocabulary ships
  updated_at: iso8601,
  surfaces: [
    {
      id,
      origin_key,
      path_key,
      location,
      kind?,
      methods?: string[],
      params?: string[],
      status,                 // seen | touched | booked (+ legacy mapped)
      source?,                // traffic | target_seed | finding | import | agent_upsert
      source_agent_id?,
      first_seen_at?,
      last_traffic_at?,       // evidence for “has test traffic”
      platform_sync?,
      updated_at,
      created_at?
    }
  ]
}
```

WS: `surface_upsert` by identity (retain).

### D10 — Frontend

- Surface tab = Case `surface_ledger` only (v1 #375 stands).
- Empty with zero traffic may still be honest at t0; empty after heavy traffic is a settle bug.

### D11 — Graph gates

- Gates may read Surface for coverage honesty; **prefer not** to force Agent attention onto manual surface ops.
- Soft process signals (“high prior-only pattern”) later; hard gates secondary to passive settle.

### D12–D13 — Migration / import

- Retain JSON→SQLite one-shot and import merge-by-identity from v1.
- Import rows map into v2 status vocabulary.

### D14 — Out of scope for this Spec body

- Full automated recon pipeline (OpenAPI crawler skill, browser feature walk) — harness/pack tickets; must **feed** Traffic so settle still owns ledger fill.
- MITM job D.
- Asset table PK migration (#322).
- Keyword intent routing.

### D15 — Modules (logical, v2 delta)

| Module | v2 work |
|--------|---------|
| Traffic collect | On exchange complete → call Surface settle |
| Surface settle pure | URL→identity, status advance, noise filter |
| SQLite + dual-write | Already exist; wire settle + last_traffic_at |
| finding book | Fix location resolve; enforce traffic evidence for booked |
| Agent context | Optional compact Surface summary injection |
| `surface` tool | Prefer list/summary; document upsert non-primary |
| FE | Status labels seen/touched/booked if vocabulary changes |

---

## Testing Decisions

### Good tests

External behavior: traffic in → surface row; second request → touched; confirm → booked; confirm without resolvable/trafficked identity → no fake complete (or create only per D7 rules); Agent cannot mark booked via ordinary surface op; FE shows ledger only.

### Seams

| Seam | External behavior |
|------|-------------------|
| **S1 Identity & status** | Normalize identity; no status downgrade; booked only via allow_booked/confirm path |
| **S2 Traffic settle** | Complete exchange upserts surface; TARGET seed present; noise filtered per policy |
| **S3 Dual-write** | Local + async Platform (retain) |
| **S4 Case project** | Snapshot + WS (retain) |
| **S5 Confirm → booked** | Resolve host+port+path; traffic evidence rule; finding never fails |
| **S6 FE** | Ledger only (retain) |
| **S7 Import** | Merge by identity (retain) |
| **S8 No fake complete** | Reject complete without traffic evidence |

### Prior art

#309 traffic tests; v1 surface-identity / surface-sqlite / surface_ledger.py / FE ledger tests; booking tests.

---

## Out of Scope

- Using global asset.urls as Surface SoT.
- Requiring Agent deliberate surface registration for normal fill.
- Auto-book findings without confirm.
- Full MITM.
- Treating model prior path lists as ledger rows **without** a corresponding request (no traffic, no row).

---

## Further Notes

### Relation to #309

Traffic is L0 capture. Surface is L1 **settled management ledger derived from Traffic** (plus seed/import). Agent may still `traffic_list` for raw detail.

### Relation to #280 / #322

Unchanged layer split: Case Surface vs long-lived Asset inventory vs Traffic. v2 changes **how Surface fills**, not the layer boundaries.

**Durable surface identity inventory (Spec [#410](https://github.com/zangjiaao/my-ai-pen/issues/410)):** platform `surface_inventory` precipitates origin_key+path_key for **NEW** only (user-scoped; optional `asset_id` when Host exists). Case `surface_ledger` remains live SoT for TESTED/traffic/booked. Full Host→Service→Observation redesign stays Spec [#322](https://github.com/zangjiaao/my-ai-pen/issues/322) — #410 is a thin novelty baseline, not a competing inventory object model.

### Field lesson (Case 77fc1ff9 / similar)

- Agent had path knowledge from **priors + model**, verified via **shell curl batches**, not browser/bruteforce/traffic tools.
- Chat said “discovered surfaces”; Surface SoT empty — **v1 model failed Agents**.
- Findings booked while surface side-effect unparseable — **implementation gap under D7**.

### Operator expectation after v2

- Active probing ⇒ Surface grows from traffic settle.
- Booked finding ⇒ matching surface booked when identity resolvable + traffic rules satisfied.
- “Discovered surfaces” in chat should be checkable against ledger counts.

### Living status (implementation)

| Area | Behavior now (code as of v1 ship) | v2 gap |
|------|-------------------------------------|--------|
| Node store | SQLite + surface tool + gates; status vocab seen/touched/booked (#379) | — |
| Dual-write | #374 async surface_upsert | Unchanged topology |
| Traffic→Surface | **#380:** on exchange complete/fail, HTTP(S) settle → SQLite + dual-write; static denylist; first→seen later→touched | — |
| TARGET seed | **#381:** task start seeds TARGET + scope.allow web roots as `seen` (`source=target_seed`) | Traffic settle advances seed rows to touched |
| Finding→booked | **#382:** resolve absolute URL → host+port+location_key → proof URL; create-on-book with strong identity; soft-fail unparseable (finding never fails) | — |
| FE | Case ledger only | Label/status display if vocab changes |
| Agent summary | **#383:** `surface(op=summary)` counts + samples; list/get primary; upsert non-primary; prompts tool-first (no every-turn inject) | — |

---

## Open implementation knobs (to grill next)

These are **not** locked; resolve before/during v2 implementation tickets:

1. ~~**Noise filter**~~ → **Locked D6.1:** default settle + static suffix denylist (static path not a Surface row).
2. ~~**seen vs touched**~~ → **Locked:** keep **seen / touched / booked**.
3. ~~**JS / SPA mining**~~ → **Locked as Capture follow-on (D6.2):** post-capture clue mining (pluggable analyzers; feed Agent); optional later bridge into Surface `seen`; **not** Surface v2 minimum DoD.
4. ~~**Create-on-book**~~ → **Locked D7:** strong identity evidence (absolute URL and/or host+port+location_key) **may create booked** even without prior traffic; unresolved identity → no complete tag (finding still ok).
5. ~~**Settle timing**~~ → **Locked:** settle on each exchange **complete** immediately (no debounce required).
6. ~~**Agent context injection**~~ → **Locked:** tool-first (`surface` list/summary/get); no every-turn auto-inject.
7. ~~**Surface tool upsert**~~ → **Locked:** keep registered; non-primary; prompts do not require it.
8. ~~**Non-HTTP**~~ → **Locked for v2:** HTTP(S) settle only; other schemes later.
9. **Capture enrichment (D6.2) ticket scope** — separate from Surface v2 DoD: clue types (paths vs secrets), browser vs shell-fetched JS, plugin interface. Grill when that ticket is opened.

### Locked summary (v2 product + knobs)

| Item | Decision |
|------|----------|
| Audience | Agent working memory first |
| Row birth | Runtime Traffic settle + TARGET seed |
| Noise | Default settle + static suffix denylist |
| JS/SPA mining | Capture enrichment later (D6.2); feed Agent; optional Surface bridge later |
| Status (v2 internal) | seen → touched → booked |
| Status (v3 operator UI) | **NEW** (inventory) + **TESTED** (this Case traffic) + finding tags — see [`surface-new-tested-coverage.md`](surface-new-tested-coverage.md) |
| Complete | finding confirm only; create-on-book with **strong** identity; no fake complete |
| Settle timing | Per exchange complete, immediate |
| Agent read | surface list/summary/get tool-first |
| upsert | Keep, non-primary |
| Protocol | HTTP(S) only for v2 settle |
| Caps | page 200 / hard 2000 |

---

## Amendment checklist (for implementers)

- [x] Traffic complete → Surface settle (Node + dual-write) — #380
- [x] TARGET/scope seed at task start (#381)
- [x] Status: seen / touched / booked (+ migration map) — #379
- [x] Confirm → booked with robust location resolve; create-on-book with strong identity (#382)
- [x] Agent-facing summary/list aligned to management purpose (#383)
- [x] Docs/prompts: deposit-not-required; explore generates traffic; confirm completes (#383)
- [ ] Tests S2 + S5 + S8; regression on unparseable `PUT /api/...` locations (S2 covered in #380; summary seam in #383)
