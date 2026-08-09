# Spec: Case Surface ledger (shared attack-surface SoT)

**Status:** approved for implementation (not yet implemented)  
**Issue:** [#368](https://github.com/zangjiaao/my-ai-pen/issues/368)  
**Related:** Product state → UI passive projection ([#280](https://github.com/zangjiaao/my-ai-pen/issues/280), later-wave attack surface); Case traffic audit ([#309](https://github.com/zangjiaao/my-ai-pen/issues/309)); base booking / finding id ([#279](https://github.com/zangjiaao/my-ai-pen/issues/279)); task-graph surface coverage ([`task-graph.md`](task-graph.md)); Asset inventory ledger Host → Service → Observation ([#322](https://github.com/zangjiaao/my-ai-pen/issues/322), **after** this Case Surface SoT); ADR 0001 Graph × Pi

**Product path:** Node4 Agent Runtime (SQLite working store + `surface` tool) · Platform Case document + WS projection · Conversation right-panel Surface tab  

**Does not implement product code in this document** — normative contracts only. Decisions locked via grilling (2026-08-10).

---

## Problem Statement

Operators watching a long Expert Graph / Free run often see an **empty or misleading Surface panel**, even when recon has already deposited dozens of paths in the Node task workspace.

Today there are **three disconnected notions** of “attack surface”:

1. **Node `taskDir/surfaces/ledger.json`** — Agent `fact(op=surface)` and Graph coverage gates; **not projected** to the Case UI.
2. **UI Surface tab** — Frontend merges **engagement target + Case assets (`properties.urls`) + plan_tree surface nodes + finding paths**. Host assets are user-created; agents only enrich. Booking a finding can attach a **global** host asset (with historical URLs from other labs) to the Case, so the panel can **suddenly fill with stale DVWA/Juice noise**.
3. **Traffic audit (#309)** — Honest capture of HTTP exchanges; **not** the Surface inventory.

Consequences:

- Empty Surface does **not** mean “no recon”; full Surface does **not** mean “this Case’s ledger.”
- Agent and UI do not share one Product SoT.
- Continuous recon cannot be trusted as a single evolving inventory.

Product intent: **capture is raw material; Agent analyzes and deposits attack surface into a fixed shared ledger; UI only projects that ledger; Agent continues to iterate the same ledger as probing deepens.**

---

## Solution

### End-to-end flow

```text
Capture (Traffic #309)     →  raw material (queryable: latest / paginated)
Agent `surface` tool       →  analyze + deposit (continuous upsert)
Node SQLite (task/Case)    →  Agent + Graph-gate working store (fast read)
Dual-write (async)         →  Platform Case `context.surface_ledger`
UI Surface tab             →  subscribe/project Case ledger only
Offline                    →  local SQLite; export → import into Platform
```

### Roles

| Role | Responsibility |
|------|----------------|
| **Agent (Main + Worker)** | Call tools; **deposit** surfaces via `surface` tool; **read** working queue from Node (page ≤200); does **not** maintain UI lists or enrich global assets to “feed Surface” |
| **Node Runtime** | Own SQLite surface store; implement `surface` tool; Graph gates read **local** store; online **dual-write** to Platform (async); migrate legacy JSON once |
| **Platform** | Case-scoped `surface_ledger` document; snapshot + WS `surface_upsert`; import merge; finding-booked side-effect |
| **Frontend** | Project Case ledger only; empty ledger ⇒ empty Surface (**correct**) |

### Dual mode (online / offline)

| Mode | Write | Agent / gate read | UI |
|------|-------|-------------------|-----|
| **Online** (Node bound to Platform) | Local SQLite **required** for tool `ok`; Platform **async** sync with `platform_sync`: `pending` \| `ok` \| `error` + retry | **Node SQLite** | **Case** ledger after sync (may lag seconds) |
| **Offline** / standalone | Local SQLite only | Local SQLite | N/A until import |

**Uniqueness rule:** Agent always reads the Node working store after a successful local write. Platform is the **Case product copy** for UI, multi-client, and import. Sync lag must not silently invent a second inventory semantics—UI may be briefly behind, never a different merge algorithm.

### What is *not* Surface

- Traffic exchanges (raw capture)
- Global asset `urls` bags
- Chat prose / tool stdout
- Automatic dump of every observed URL

---

## User Stories

1. As an **operator**, I want Surface to show only the Case attack-surface ledger, so that empty means nothing was deposited for this Case.
2. As an **operator**, I want Surface to grow as the engagement deepens, so that I can see recon progress without reading the whole chat.
3. As an **operator**, I want Surface **not** to suddenly fill with URLs from other labs on the same hostname, so that historical asset noise does not pollute this Case.
4. As an **operator**, I want multi-protocol entries (HTTPS, SSH, Redis, MySQL, …) under `scheme://host:port`, so that non-HTTP services are first-class.
5. As an **operator**, I want live updates when surfaces are deposited, so that I do not refresh manually.
6. As an **operator**, I want offline standalone work to remain inspectable and later importable, so that lab runs can join the platform Case model.
7. As an **Agent**, I want a dedicated `surface` tool (not process-fact), so that attack-surface deposit is explicit and listable.
8. As an **Agent**, I want to list only open / in-probe surfaces in pages of 200, so that my context stays bounded while the Case may hold more rows.
9. As an **Agent**, I want `has_more` / total counts when listing, so that I can consume the queue in producer–consumer batches.
10. As an **Agent**, I want to upsert the same path repeatedly as params grow, so that JSON body fields merge into one entry instead of exploding rows.
11. As an **Agent**, I want Traffic query (latest + paginated full) as raw material, so that I analyze captures without memorizing every tool blob.
12. As an **Agent**, I want deposit success when local SQLite write succeeds online, so that I am not blocked on Platform latency.
13. As a **Worker**, I want to deposit surfaces into the same Case ledger as Main, so that parallel recon is not lost.
14. As **Graph Runtime**, I want coverage gates to read the Node surface store, so that `todo(done)` still reflects real open paths.
15. As **Graph Runtime**, I want status transitions that never downgrade, so that probed/booked work is not erased by a careless re-deposit.
16. As **booking Runtime**, I want successful `finding(confirm)` to mark or create the matching surface as `booked`, so that coverage and Findings stay aligned.
17. As **booking Runtime**, I want finding booking to succeed even if surface hard-cap blocks a new surface row, so that Product vulns are never blocked by inventory limits.
18. As **Platform**, I want Case-scoped storage and snapshot fields, so that clients agree on membership.
19. As **Platform**, I want WS upsert-by-identity, so that live UI matches the ledger without full replace storms.
20. As an **implementer**, I want a write hard-cap of 2000 rows per Case, so that runaway deposits cannot explode storage.
21. As an **implementer**, I want legacy `ledger.json` one-shot migration into SQLite, so that in-flight tasks do not lose coverage state.
22. As an **implementer**, I want import package surface data merged by identity, so that offline packages upgrade the existing sync import path.
23. As a **future Asset owner**, I want origin keys documented as the future asset primary key, so that host inventory can align later without redoing Surface identity.
24. As a **product owner**, I want Todo/Finding dual-write SQLite patterns documented as out-of-scope principles only, so that this spec stays AFK-finishable.
25. As an **operator**, I want no automatic TARGET seed into the ledger, so that Surface only contains deposited (or finding-side-effect) rows.
26. As an **Agent**, I want upsert batches small enough per call (e.g. ≤20), so that a single tool call cannot flood the store.
27. As an **operator**, I want status visible on surface rows (open / probed / booked / …), so that coverage is understandable without opening Findings.
28. As **Platform sync**, I want failed Platform writes to be retried and observable, so that UI eventually converges with Node.
29. As a **frontend engineer**, I want a single projection path, so that asset/plan/finding merge code can be deleted from Surface.
30. As a **security engineer**, I want path identity without query strings as keys, so that parameterized probes do not create infinite surfaces.
31. As a **security engineer**, I want REST JSON parameters as merged `params`, so that body fields are test dimensions on one endpoint.
32. As an **Agent**, I want list filters by origin and status, so that I can focus one service at a time.
33. As **Node offline**, I want full gate and deposit behavior without Platform, so that standalone lab remains valid.
34. As an **importer**, I want merge (not blind replace) on import when targeting an existing Case flow, so that later imports deepen the ledger.
35. As a **spec consumer**, I want explicit non-goals, so that agents do not “helpfully” auto-fill Surface from Traffic.

---

## Implementation Decisions

### D1 — Product SoT vs working store

- **UI / Case product SoT:** `conversation.context["surface_ledger"]` document on Platform (first version; not a separate DB table).
- **Agent / Graph-gate working store:** Node **SQLite** per task workspace (Case-scoped logical ledger; cumulative for the conversation when online).
- Online: **dual-write** — local commit required for tool success; Platform **async** with `platform_sync` state and retry.
- Offline: local only; export/import elevates to Platform.

### D2 — Identity (two-level)

- **Origin key** (normalized): `scheme://host:port`
  - scheme lowercased; host lowercased; **port always explicit** (including defaults 80/443/22/6379/…).
  - IPv6 in bracket form.
  - Examples: `https://host.docker.internal:3000`, `ssh://1.1.1.1:22`, `redis://10.0.0.1:6379`.
- **Surface row key:** `origin_key` + `path_key`
  - HTTP(S): normalized path (no query/fragment; trailing-slash rules consistent with existing pathKey semantics).
  - Non-HTTP: `path_key` empty (single row per origin).
- **Not in primary key:** HTTP method(s), query, JSON body fields, headers.
- **Merged attributes:** `methods[]`, `params[]` (union; optional `param_in` later), `kind`, `auth`, `note`, `source_agent_id`, timestamps.
- **Future assets:** product direction is asset primary key = **origin key**; this spec does **not** migrate the assets table.

### D3 — Status machine

```
open → in_probe → probed | booked | deadend | skipped_roe
```

- Same path re-deposit: **never downgrade** status; only enrich attributes or advance forward.
- Ordinary `surface.upsert` **must not** set `booked`.
- **`booked` only via finding booking path** (D7).

### D4 — Scope and caps

- **Case-level** cumulative ledger (one inventory per conversation).
- **Agent read page size:** default **200**; support status/origin filters; pagination; response includes `returned`, `total_matching`, `has_more`.
- **Write hard-cap:** **2000** surfaces per Case (configurable; recommended config ceiling ≤5000). Excess upsert **rejected** with clear error.
- **Per-call batch:** recommend max **20** surfaces per upsert call.
- Rationale: 200 bounds **context**; 2000 bounds **accident**; industry single-app OpenAPI averages are tens of paths—thousands usually means scope or noise failure.

### D5 — `surface` tool (new; not `fact`)

Ops (minimum):

- `upsert` — one or many surfaces (identity merge).
- `list` — default filter: actionable queue `open` + `in_probe`; limit default 200.
- `get` — by identity or id.

Behavior:

- Main **and** Worker may call upsert into the **same** logical Case ledger.
- Online `ok: true` iff **local SQLite** write succeeded; include `platform_sync` field.
- Do not require Agent to call platform enrich-asset for Surface visibility.

Deprecate product guidance that uses `fact(op=surface)` as the UI/coverage deposit path; migrate callers to `surface`.

### D6 — Capture as raw material only

- Traffic (#309) remains passive Runtime collect.
- Agent **queries** traffic: prefer **latest/delta**; also **paginated full**.
- Prefer path-aggregated summaries for analysis prompts; full bodies on demand.
- **No** automatic insert from traffic rows into surface ledger (optional short “unfiled path count” hint is later, not DoD).
- **Implemented (#378):** Node4 tool `traffic_list` reads a **session** Runtime store filled by collect hooks (summary by default; `since_sequence` delta; `offset`/`limit` page; optional `aggregate_paths` / `include_bodies` / `exchange_id`). Collect path does not write surface ledger. Residual: Case-history list via Platform HTTP after process restart is not Agent-tool-backed yet (operator Traffic panel / snapshot remains panel SoT).

### D7 — Finding → surface side-effect

On successful Case booking (`finding(confirm)` / `vuln_found` persist success):

1. Resolve origin + path from finding location.
2. If matching surface exists → set status `booked` (no downgrade from booked).
3. If none → **system create** one row (`source=finding`, status=`booked`).
4. If hard-cap would block create → **skip surface create**, still keep finding; emit warning/metric.
5. This is an allowed **system write** exception to “Agent-only deposit.”

### D8 — No TARGET auto-seed

- Engagement target / scope.allow are **not** auto-inserted into the ledger.
- Empty Surface at task start is correct until deposit or finding side-effect.

### D9 — Platform document shape (logical)

```text
surface_ledger: {
  version: 1,
  updated_at: iso8601,
  surfaces: [
    {
      id,                    // stable; may equal path identity hash
      origin_key,            // scheme://host:port
      path_key,              // "" for non-HTTP
      location,              // display / original location string
      kind?,                 // url | ssh | redis | mysql | ...
      methods?: string[],
      params?: string[],
      auth?,
      status,                // open | in_probe | probed | booked | deadend | skipped_roe
      note?,
      source?,               // agent | finding | import | ...
      source_agent_id?,
      platform_sync?,        // optional on Node side only
      updated_at,
      created_at?
    }
  ]
}
```

WS event: **`surface_upsert`** — merge by identity (`origin_key` + `path_key`) into Case document; snapshot field `surface_ledger` (or `surfaces` array alias—pick one name and stick to it in implementation).

### D10 — Frontend projection

- Surface tab reads **only** Case `surface_ledger` (snapshot + live upserts).
- **Remove** as Surface inventory sources: `collectSurfaceEntries` from assets.urls, plan_tree surface/request nodes, engagement target seed, finding-only tree building as primary inventory.
- Findings may still **badge** onto ledger paths when identities match; unlinked findings do not invent a parallel tree.
- Empty copy remains honest (e.g. “No attack surface recorded yet”).

### D11 — Graph gates

- Coverage / `todo(done)` surface checks read **Node SQLite** (working store), not FE.
- After dual-write design, local store is the gate truth; Platform lag does not block local gates.

### D12 — Migration

- On first open of a task that still has legacy `surfaces/ledger.json` and empty/missing SQLite: **one-shot import** into SQLite (preserve statuses), then archive or leave file read-only.
- No long dual-read period.

### D13 — Offline import/export

- Existing Platform `/api/sync/import` already accepts `attack_surface.json` into a new conversation context (mvp-demo format).
- **Refactor** that path to:
  - Accept **surface_ledger** schema (D9);
  - **Upsert-by-identity** merge semantics;
  - Populate Case `surface_ledger` used by UI (not only a dead context key FE ignores).
- Export from Node standalone should emit the same schema from SQLite.
- Full redesign of the entire report tarball is not required beyond surface section + compatibility notes.

### D14 — Spec scope boundary

- **In scope:** Surface ledger only (tool, SQLite, Case doc, WS, FE, finding side-effect, import surface section, JSON migration).
- **Documented principle only (not DoD):** Todo / Finding process artifacts may later use the same dual-mode “Node working store + async Platform” pattern; do not implement in this issue.

### D15 — Modules (logical)

- Node: surface SQLite store; `surface` tool; dual-write publisher; gate integration; JSON migration; traffic list helpers if missing for Agent raw material.
- Platform: context merge for `surface_ledger`; snapshot; WS `surface_upsert`; booking side-effect; sync import refactor.
- Frontend: Surface tab pure projection from ledger; delete multi-source inventory merge for this tab.

---

## Testing Decisions

### What makes a good test

- Assert **external behavior** (tool results, Case document membership, WS payload identity, FE empty-when-empty).
- Prefer **pure functions** for identity, status monotonicity, merge of params/methods.
- Do not assert private file paths or SQL as the product contract—SQLite is an implementation of the working store seam.
- Prefer highest seam: tool → store → platform fake → snapshot/UI pure projection.

### Seams (approved)

| Seam | External behavior |
|------|-------------------|
| **S1 Identity & status pure** | Origin + path_key normalize/dedupe; params/methods merge; no status downgrade; upsert cannot set `booked` |
| **S2 Node `surface` tool + SQLite** | list/get/upsert; default actionable queue; page ≤200 + has_more; hard-cap 2000 reject; Main+Worker write; JSON→SQLite one-shot migrate |
| **S3 Online dual-write** | Local success ⇒ ok; Platform async pending/ok/error; retry converges identity set |
| **S4 Platform Case project** | context ledger upsert-by-identity; snapshot; WS `surface_upsert`; no cross-Case leak |
| **S5 Finding → booked** | Match advance; missing create; cap skip does not fail booking |
| **S6 FE Surface SoT** | Only Case ledger; empty ledger ⇒ empty panel; no asset.urls primary tree |
| **S7 Import** | Package surface_ledger merge by identity into Case |

### Prior art

- Traffic audit pure/view tests and snapshot purity tests (#309 / #280).
- Existing Node `surface-ledger` unit tests (status/gate) — rehome semantics onto SQLite + tool.
- Booking / `vuln_found` tests for finding side-effect attachment.

---

## Out of Scope

- Auto-creating Surface rows from every Traffic exchange.
- Using or expanding global **asset.urls** as Surface SoT.
- Migrating Asset table primary key to origin (declaration only).
- Full Todo / Finding SQLite dual-write implementation.
- MITM / full egress capture (owned by traffic job D).
- Soft Graph / Node5 / co-equal Python kernel.
- Raising write cap by inventing per-target benchmark profiles.
- Agent keyword/intent routing to choose surface workflows.
- Hardcoded vulnerability or surface lists for demos.

---

## Further Notes

### Relation to #280

Wave 1 delivered Findings + Evidence pure projection. This spec **is** the Case **Surface coverage** projection wave (right-panel Surface tab SoT): same role split (Agent tools → Runtime/Platform store → UI project), with the dual-mode working store for Agent efficiency. It is **not** the long-lived Host/Service asset inventory wave (#322).

### Relation to #309

Traffic is **L0 observability**. Surface is **L1 Agent-judged Case coverage ledger**. Both are Case-scoped product state; neither replaces the other.

### Relation to #322 (Asset inventory — depends on this Spec)

**Layer split (locked):**

| Layer | Owner Spec | What it is |
|-------|------------|------------|
| **Case Surface ledger** | **This doc / #368** | This-engagement coverage: `origin_key` + `path_key`, status machine, Agent `surface` tool, Node SQLite + Platform dual-write, UI Surface tab |
| **Asset inventory** | **#322** | Long-lived Host → Service → Observation + tags; Finding `service_id`; `inventory_summary`; promote/adopt/pin |
| **Traffic** | #309 | Raw capture; never auto-fills Surface |

**Precedence when object descriptions conflict:** **#368 / this living doc wins** for Surface rows, Surface tab, origin/path identity, status machine, dual-write, Graph gate surface reads, and finding→`booked` surface side-effect. #322 must **not** redefine Surface as asset.urls, path-as-Asset, or a second Case coverage SoT.

**#322 depends on #368 implementation** for:

- Surface tab data source (Case `surface_ledger` only — #375).
- Working-store semantics Agents and gates already use (SQLite + `surface` tool).
- Promote/adopt UX: act **from Surface origin rows or Host detail**, never re-merge global assets into the Surface tree.
- Finding book composes side-effects: #368 surface `booked` **and** #322 Service attach — both may run; neither replaces the other.

**Not required by #368 DoD:** auto-mirroring Surface deposits into Services/Observations. That bridge (if ever) is an explicit #322 or later decision; V1 inventory still forbids hydrating priors into Surface as probed (R4).

### Operator expectation after ship

- Mid-run empty Surface ⇒ Agent has not deposited (or sync pending)—check tool use / `platform_sync`, not asset attachment.
- Finding booked without prior deposit ⇒ system-created `booked` row appears.
- 200 list page ≠ 200 total; Agent must page through `has_more`.

### Open implementation knobs (non-blocking)

- Exact SQLite file location under taskDir.
- Retry backoff for Platform sync.
- Whether import always creates a new conversation (today) vs merge-into-existing Case (prefer supporting ledger merge either way).
- Optional later: stage-boundary “N unfiled traffic paths” hint (not SoT).

### Living status (fill on implement)

| Area | Behavior now |
|------|----------------|
| Node store | **#370:** SQLite `taskDir/surfaces/ledger.sqlite` + `surface` tool (upsert/list/get); one-shot migrate from `ledger.json`; legacy JSON dual-write bridge until #371 gates switch. Identity pure: `surface-identity.ts` (#369) |
| UI Surface | multi-source merge (pre-spec; #375) |
| Case document | Platform `conversation.context.surface_ledger` + snapshot + WS `surface_upsert` (#373 / dual-write #374) |
| Tests | Platform pure merge + snapshot project (`tests/test_surface_ledger.py`); Node identity pure (#369); tool+SQLite seam `node4/src/tools/surface.test.ts` (#370) |
