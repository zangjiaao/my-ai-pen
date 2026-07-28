# Research: multi graphId catalog + resolveHardGraph path today

> Ticket: GitHub **#214** · Map **#213** (Composable Graph assembly)  
> Repo sources only — **no product feature code** in this resolution.  
> Date: 2026-07-28 · branch `research/multi-graphid-catalog-resolve` (base main `3378b8c`)

## Question

What exists today for **multiple Expert Hard Graphs per pack** and how does the product resolve which Graph runs?

Surface facts (code + docs, not product decisions):

1. Where packs declare graph ids (`experts/*/graphs/hard/*.json`, registries, engagement templates).
2. How platform/UI/Node choose a graph (`engagement_template`, `graph_execution`, `resolveHardGraph` / `resolveExpertWorkPath`, sticky defaults).
3. Whether switching `graphId` across tasks in the same Case is supported, accidental, or blocked.
4. Gaps relative to map charting lock **Compose unit** (optional different graphId per round under Case continuity).

Prior research (imported — skimmed, not re-done):

- Graph vs free selection: `docs/wayfinder/research-graph-vs-free-selection-today.md` (branch `research/graph-vs-free-selection-today` / commit `296161b`, map #205 ticket #206) — path chain UI → platform C1 → Node.
- Goal vs Graph runner: `docs/wayfinder/research-goal-mode-vs-graph-runner.md` (branch `research/goal-mode-vs-graph-runner` / commit `e007e90`, map #205 ticket #207) — Goal does not schedule Graph / second full run.

---

## Executive answer

| Area | Maturity | Verdict for #213 Compose unit |
|------|----------|-------------------------------|
| **On-disk multi Hard Graph files (pentest)** | **Shipped** | Three files: `app_assessment`, `app_assessment_thin`, `redteam_deep` under `experts/pentest/graphs/hard/` |
| **Node product catalog + aliases** | **Shipped** | `PRODUCT_GRAPH_CATALOG` maps many aliases → 3 hardIds; direct file load for any id with a hard JSON |
| **Platform product templates** | **Shipped (2)** | `PRODUCT_GRAPH_TEMPLATES` = `{app_assessment, redteam_deep}` only; thin is **not** product-selectable |
| **UI Mode chips** | **Shipped (2)** | Same two ids; sticky default `app_assessment` on pentest seat |
| **Per-assign resolve which Graph** | **Shipped** | Structured `graphId` \| `engagementTemplate` → `resolveHardGraph` → definition; then `resolveExpertWorkPath` gates hard vs free vs fail-closed |
| **C1 post-complete** | **Shipped** | Product template + conversation `completed` → `graph_execution=continue` → free-in-envelope (**no** stages), independent of *which* graphId was sticky |
| **Switch graphId same Case** | **Structurally allowed; product loop weak** | Sticky overwrite works (UI Mode + `merge_case_into_context`); **not** blocked by close-out `graphId`. After complete, switch alone still lands **continue** unless explicit `graph_execution=full` |
| **Agent / Route chooses graphId** | **Missing** | No Agent judgment step; UI sticky / structured field only (matches #206 findings) |
| **Per-round different graphId under Goal / assembly** | **Missing** | No orchestrator issues multi-round Graph with optional new `graphId`; Goal does not set `full` (#207) |
| **Non-pentest multi-Graph packs** | **Absent** | `resolveHardGraph` early-outs `not_hard` when `packId !== "pentest"`; other packs have no `graphs/hard/` |

**One sentence:** The framework already has a **multi-Graph catalog** (files + Node aliases + two product UI templates), and **each `task_assign` resolves exactly one hard definition** from structured template/id fields — but **Case multi-round “optional different graphId next round”** is not a first-class product loop: sticky Mode can change the id, while C1 + lack of Agent Route/`graph_execution=full` policy mean rounds do not deliberately re-enter Hard with a new catalog entry under continuity.

---

## 1. Where packs declare graph ids

### 1.1 On-disk Hard Graph files

| Pack | Path | Hard ids present |
|------|------|------------------|
| **pentest** | `experts/pentest/graphs/hard/*.json` | `app_assessment`, `app_assessment_thin`, `redteam_deep` |
| **all other packs** | (no `graphs/hard/`) | — |

Each file is a Hard Graph definition: `discipline: "hard"`, `id`, `label`, optional `roe`, ordered `stages[]` (see `isHardGraphDefinition` in `node4/src/runtime/hard-graph-definition.ts`).

| File id | Product / lab | Notes (from JSON) |
|---------|---------------|-------------------|
| `app_assessment` | **Product primary** | Mature stage list (init → surface → auth_session → class_probe → authz_logic → component → validate_book); `roe.allow_postex: false` |
| `redteam_deep` | **Product phase 2** | Assessment-like probe stages + `chain` / `postex` / `lateral` + validate_book; `roe.allow_postex: true` |
| `app_assessment_thin` | **Lab / compat only** | Shorter stage list (init → surface → class_probe → validate_book); not in platform/UI product set |

Loader: `loadHardGraphFile(packRoot, graphId)` → `packRoot/graphs/hard/{graphId}.json`.  
Enumerator: `listHardGraphIds(packRoot)` (filesystem `*.json` names) — used in tests/smoke; **not** wired as a product catalog API for the UI.

### 1.2 Shared pack catalog (pack id, not graph id)

`experts/catalog.json` and `experts/pentest/pack.json` list pack **aliases** including `app_assessment` and `redteam_deep`. Those aliases route **role/engagement → pentest pack**, not a multi-entry Graph menu. Pack `aliases` do **not** declare the full Hard Graph file set (thin is absent from pack aliases).

### 1.3 Node in-code product Graph catalog

Primary: `node4/src/runtime/hard-graph-definition.ts` — `PRODUCT_GRAPH_CATALOG`.

```text
intentId / hardId clusters:
  app_assessment          ← app_assessment, assessment, assess, pre-prod, preprod,
                            hard_app_assessment, app_assessment_hard, hard
  app_assessment_thin     ← app_assessment_thin, hard_app_assessment_thin, thin
  redteam_deep            ← redteam_deep, redteam, red-team, deep
```

- Entry with `hardId` → Expert Graph file under `graphs/hard/{hardId}.json`.
- Comment law: shared by `resolveHardGraph` and fail-closed intent (`resolveGraphIdFromTask` via `resolveGraphIntentCanonical`).
- `DEFAULT_HARD_GRAPH_ID = "app_assessment"` when discipline/env hard without an explicit alias.

### 1.4 Platform product template set

Primary: `platform/backend/app/services/case_engagement.py`

| Constant / API | Value |
|----------------|--------|
| `TEMPLATE_APP` / `TEMPLATE_DEEP` | `app_assessment` / `redteam_deep` |
| `_TEMPLATE_ALIASES` | Subset of Node aliases (no thin/lab cluster) |
| `PRODUCT_GRAPH_TEMPLATES` | frozenset of those **two** product ids |
| `normalize_product_engagement_template` | free/none → clear sticky; only product Graph ids stick for Case writes |
| `is_product_graph_template` | true only for the two product ids |

**Divergence:** Node catalog + disk know **thin**; platform product surface does **not** normalize or offer thin. CLI/lab can still pass `graphId=app_assessment_thin` into Node directly.

### 1.5 UI template catalog

Primary: `platform/frontend/src/lib/experts.ts`

- `EngagementTemplateId = "app_assessment" | "redteam_deep"`
- `ENGAGEMENT_TEMPLATES`: two Mode chips (label, description, `allowPostex`)
- Comment: free is Default seat only — no Expert free chip
- Pack map: both templates → `"pentest"`

### 1.6 Spec law

`docs/specs/task-graph.md`: Expert = Graph mode only; **multi-Graph per expert**; product templates `app_assessment` + `redteam_deep`; thin lab alias called out under Task Graph mapping; Soft retired.

`docs/specs/harness.md`: resolve via `resolveHardGraph`; product configs under `experts/pentest/graphs/hard/`.

---

## 2. How platform / UI / Node choose which Graph runs

### 2.1 End-to-end chain (which **id**, then which **path**)

```text
UI Mode chip (or sticky restore / default app_assessment)
  → user_message { engagement_template?, allow_postex?, … }
  → platform:
       · merge sticky Case RoE (engagement_template / allow_postex)
       · resolve_graph_execution (C1) → graph_execution? full|continue|omit
  → Node normalizeTask:
       graphId from graph_id|graphId
       engagementTemplate from engagement_template|engagementTemplate
       graphExecution from graph_execution|graphExecution
  → session-runner:
       resolveHardGraph(task, pack)     // which definition file
       resolveGraphIdFromTask(task)     // intent for fail-closed
       resolveExpertWorkPath(...)       // hard | free | unavailable
         ├─ hard  → runHardGraphExpertTask(graph)
         ├─ free  → free OMP
         └─ unavailable → task_error
```

**Who picks the id today:** UI structured Mode (sticky Case), not Agent judgment. Platform maps explicit/sticky fields only (AGENTS.md Intent law — no free-text invent). See also prior research #206.

### 2.2 UI selection + sticky default

`ConversationPage.tsx`:

| Hook | Behavior |
|------|----------|
| Enter pentest Expert | `setEngagementTemplate(prev => prev ?? "app_assessment")` |
| Effect while pentest active + template null | force `"app_assessment"` |
| Case restore | restore only `redteam_deep` \| `app_assessment`; else null (then effect re-defaults) |
| Mode menu | user picks either product template id |
| Send | if pentest + template → wire `engagement_template` + chip `allow_postex`; PUT `/case` with same |
| Leave pentest | clear template + Goal |

**Platform product wire is almost always `engagement_template`, not `graph_id`.** Grep of platform send path shows `engagement_template` on assign; `graphId` appears mainly on close-out payloads / display, not as a first-class composer field.

### 2.3 Platform Case sticky + C1

`case_engagement.py` + `ws/router.py`:

| Function | Role for multi-graph |
|----------|----------------------|
| `merge_case_into_context` | Overwrites Case/task sticky `engagement_template` when product id changes; free/none clears Graph sticky |
| `roe_payload_for_task_assign` | Emits sticky template + allow_postex on assign |
| `_merge_case_roe_into_task_assign` | Fills omitted template from Case; may set `engagement` from template for pack alias |
| `resolve_graph_execution` | Explicit full\|continue **or** product template + status completed/complete/done → **continue**; else omit (first-run full when hard resolves) |
| `_apply_graph_execution_c1` | Writes `graph_execution` on `task_assign` |

C1 is **path mode** (full stages vs free-in-envelope), **not** a graphId picker. It does not compare “last close-out graphId” vs “this assign’s template.”

`resolve_allow_postex`: explicit bool wins; else `redteam_deep` → true, else false. Switching template re-derives postex unless explicit override (tests cover stale-postex / deep switch).

### 2.4 Node: `resolveHardGraph` (which definition)

Primary: `hard-graph-definition.ts` `resolveHardGraph`.

| Condition | Result |
|-----------|--------|
| `packId` set and **not** `pentest` | `not_hard` (**all multi-Graph product load is pentest-scoped today**) |
| `task.graphId` or `task.engagementTemplate` maps catalog **hardId** | load that hard file → `hard` |
| `graphDiscipline === "hard"` or env `NODE4_HARD_GRAPH` | default hard id `app_assessment` if no alias |
| raw id with hard file under pack (even outside catalog aliases) | load direct → `hard` (**multi-Graph catalog comment in code**) |
| else | `not_hard` |

**Priority of raw id string:** `graphId` **before** `engagementTemplate` (same lowercased trim). Product UI only supplies the latter; lab/CLI may set `graphId` (`standalone.ts` maps `--graph-id`).

### 2.5 Node: `resolveGraphIdFromTask` (intent / fail-closed)

Primary: `pentest-graph.ts`.

Candidates in order: `graphId`, `engagementTemplate`, then `engagement`/`role` **only if** they are known Graph templates (skips bare `pentest` / `ctf` / `default` / free aliases). Maps via `resolveGraphIntentCanonical` → canonical **intentId**.

`KNOWN_GRAPH_IDS` (deprecated Soft leftover name) still lists `["app_assessment", "redteam_deep"]` only — intent for free-path comments; hard load uses the fuller catalog + file existence.

### 2.6 Node: `resolveExpertWorkPath` (path after resolve)

| Input | Path |
|-------|------|
| chatOnly or ledgerAssistSeat | **free** |
| `continueInEnvelope` (C1 `graph_execution=continue`) | **free** (sticky Graph RoE/template, **no Hard stages**) |
| hardMode hard | **hard** |
| graphIntent set but not hard | **unavailable** (fail-closed `task_error`) |
| no intent | **free** |

`session-runner.ts` order: parent ToolRuntime → `resolveHardGraph` → continue flag → `resolveExpertWorkPath` → early return Hard or free OMP.

Greeting / no target: `isChatOnlyTask` forces free even if sticky product template is present (#206).

### 2.7 Runtime identity after load

Hard runner / close-out use **`graph.id` from the loaded definition** (not a second platform-side catalog). Workdirs: `taskDir/hard-graph/<graphId>/stage-…` (`docs/specs/task-graph.md`). Engagement close-out requires `graphId` field (forensic / Product state) — does not select the next run.

---

## 3. Switching `graphId` across tasks in the same Case

### 3.1 Sticky overwrite — **supported**

Evidence:

- `merge_case_into_context({}, app_assessment)` then `merge(..., redteam_deep)` → sticky becomes deep; `allow_postex` re-derived (`test_case_engagement.py` `test_merge_case_round_trip`).
- Reverse / free clear: product → free/none clears sticky so Graph does not resurrect.
- UI Mode chip can change `engagementTemplate` any time; next send PUTs Case + wires new template.

There is **no** code path that rejects “template ≠ last close-out graphId” or “template ≠ previous task template.”

### 3.2 Same Case, conversation still **completed** — switch is **partial / C1-shadowed**

If conversation status ∈ {completed, complete, done} **and** the (possibly new) sticky value is still a **product** Graph template:

```text
resolve_graph_execution → "continue"
  → Node continueInEnvelope → free path
  → Hard stages of the *new* graphId do **not** run
```

So: changing Mode from 应用评估 → 红队深度 after a finished Graph **updates sticky id + postex defaults**, but **does not by itself** schedule a full Hard re-run of `redteam_deep`. Full re-entry requires structured **`graph_execution=full`** (or equivalent synonym), same as re-running the same graph (#206 / #207 / `resolve_graph_execution` docstring).

Product UI does **not** expose a first-class “full re-run” control on the Mode chip; explicit full is a structured field seam for callers/tests/future policy.

### 3.3 Mid-flight / first-run switch

- While status is not completed: omitted `graph_execution` + hard resolve → full Hard path for **whatever** template is on that assign (sticky merge if omitted).
- Changing Mode between two first-run-style assigns before complete would load different stage definitions on separate tasks **if** each assign still resolves hard (not chatOnly, not continue). Case continuity (Finding Store / surface ledger / case_context) is shared Case state; stage plans are per Hard run under that run’s `graph.id`.
- No product “compose next graphId from close-out residual” step.

### 3.4 Classification for ticket Q3

| Pattern | Verdict |
|---------|---------|
| Overwrite sticky product template A→B | **Supported** (intentional Case merge) |
| Load hard file B when structured field is B | **Supported** (Node catalog + file) |
| Optional different graphId **next round after settle under continuity** as product policy | **Not productized** — needs explicit full + caller-chosen template; C1 defaults to free-in-envelope |
| Agent Route picks next graphId | **Missing** |
| Hard block on cross-graphId switch | **Not present** (not blocked) |
| Accidental thin/lab via product UI | **No** (UI/platform product set excludes thin) |

---

## 4. Gaps vs map #213 charting lock **Compose unit**

Map lock (from #213 body): *V1 unit = one Graph run (+ optional different graphId next round). Framework supports multi-graph catalogs; pentest need not ship split “exposure / exploit” Graphs in V1.*

| Compose-unit expectation | Today | Gap type |
|--------------------------|-------|----------|
| Framework multi-graph catalogs | **Yes** — disk + `PRODUCT_GRAPH_CATALOG` + `listHardGraphIds` + direct file load | — |
| One Graph run as unit | **Yes** — single `resolveHardGraph` per `task_assign` Hard path | — |
| Optional **different** graphId **next round** | Sticky can change; **round orchestration** (when to full re-run, how to compose prompt from Case) **missing** | Product loop / Route / C1 policy |
| Case continuity across rounds | Case sticky + close-out + stores exist; **not** wired to “next graphId” | Handoff vs Route (map language) |
| Agent chooses free vs Graph / which graphId | UI sticky default forces product Graph on pentest (#206) | L3a Expert first Route |
| Goal multi-round adopt → new Graph | Goal orthogonal; no `graph_execution=full` (#207) | L3b |
| Non-pentest catalog frame | Pack-scoped hard load refuses non-pentest | Pack wave / L4 later |
| Split exposure/exploit Graphs | Not shipped (and map says pentest need not V1) | Optional later pack content |

**Seams that already exist for a future Spec (facts, not decisions):**

1. Structured fields: `engagement_template` / `graph_id` + `graph_execution=full|continue`.  
2. Case sticky overwrite for template / allow_postex.  
3. Multi hard files + alias catalog without Soft.  
4. Fail-closed unavailable when intent without hard file.  
5. Close-out records `graphId` for history (display/SOT), not as a lock.

**What is not invented by flipping a flag:** Agent Route, Goal-driven multi-round Graph, automatic full re-run when Mode changes after complete, product UI for thin or arbitrary third pack graphs, platform discovery of `listHardGraphIds`.

---

## 5. Matrix: catalog layers (single source of truth per layer)

| Layer | Source of truth | Product surface |
|-------|-----------------|-----------------|
| Hard stage definitions | `experts/pentest/graphs/hard/{id}.json` | Loaded only if resolve selects that id |
| Node alias → hardId | `PRODUCT_GRAPH_CATALOG` in `hard-graph-definition.ts` | Lab + product aliases; includes thin |
| Platform sticky / C1 | `case_engagement.py` `PRODUCT_GRAPH_TEMPLATES` | **Two** ids only |
| UI chips | `experts.ts` `ENGAGEMENT_TEMPLATES` | **Two** ids; default app_assessment |
| Pack install catalog | `experts/catalog.json` / pack.json aliases | Pack routing, not Graph menu |
| Close-out history | `engagement_closeout.graphId` | Observability; not next-run selector |

---

## 6. Primary-source index

| Source | Path |
|--------|------|
| Hard files | `experts/pentest/graphs/hard/app_assessment.json`, `app_assessment_thin.json`, `redteam_deep.json` |
| Pack / shared catalog | `experts/pentest/pack.json`, `experts/catalog.json` |
| Node resolve + catalog | `node4/src/runtime/hard-graph-definition.ts` |
| Intent resolve | `node4/src/runtime/pentest-graph.ts` (`resolveGraphIdFromTask`) |
| Path branch | `node4/src/runtime/session-runner.ts` |
| Normalize wire | `node4/src/main.ts` (`normalizeTask`) |
| CLI graph-id | `node4/src/standalone.ts` |
| Resolve tests | `node4/src/runtime/hard-graph-definition.test.ts`, `continue-chat-c1.test.ts`, `pentest-graph.test.ts` |
| Platform templates + C1 | `platform/backend/app/services/case_engagement.py` |
| Case merge tests | `platform/backend/tests/test_case_engagement.py` |
| Assign merge / C1 apply | `platform/backend/app/ws/router.py` |
| UI templates | `platform/frontend/src/lib/experts.ts` |
| UI sticky / Mode / send | `platform/frontend/src/pages/ConversationPage.tsx` |
| Close-out graphId | `platform/backend/app/services/engagement_closeout.py` |
| Product law | `docs/specs/task-graph.md`, `docs/specs/harness.md` |
| Prior path research | `docs/wayfinder/research-graph-vs-free-selection-today.md` (branch `research/graph-vs-free-selection-today`) |
| Prior Goal research | `docs/wayfinder/research-goal-mode-vs-graph-runner.md` (branch `research/goal-mode-vs-graph-runner`) |

---

## Resolution gist (for map #213 Decisions)

**Multi-Graph is real at files + Node catalog + two product UI templates; resolution is per `task_assign` via structured template/id → `resolveHardGraph` → `resolveExpertWorkPath`.** Switching sticky `engagement_template` in a Case is allowed and rewrites RoE, but **after Graph complete C1 keeps free-in-envelope** unless `graph_execution=full` — so **optional different graphId per round under continuity is not a shipped assembly loop**, only a structural possibility. Agent Route / Goal multi-round remain gaps (consistent with #206 / #207). Non-pentest packs have no Hard Graph catalog load path today.
