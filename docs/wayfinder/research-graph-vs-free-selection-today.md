# Research: how Graph vs free is chosen today (UI → platform → Node)

> Ticket: GitHub **#206** · Map **#205** (Agent-chosen Graph + Goal multi-round suggestion loop)  
> Repo sources only — **no product feature code** in this resolution.  
> Date: 2026-07-28

## Question

Document the **current** path from UI Expert pick → `task_assign` fields → `resolveHardGraph` / `resolveExpertWorkPath` / post-complete `graph_execution=continue`.

Especially:

1. Default `app_assessment` on pentest select  
2. Whether greeting can full-Graph  
3. Goal’s role (or non-role) in path selection  

Deliverable for map #205: facts about **who chooses Graph today** (not the desired Agent-intent design).

---

## Executive answer

| Layer | Who chooses Graph vs free today? | Verdict |
|-------|----------------------------------|---------|
| **UI Expert seat** | Selecting a **pentest** Expert **defaults** `engagementTemplate` to `app_assessment` (and Mode chips are Graph-only — no Expert free chip). | **Forces Graph template on seat pick**, not Agent judgment |
| **UI send** | If pentest + template set → wire `engagement_template` (+ `allow_postex` from chip). Free seat = Default pack only. | Structured field injection |
| **Platform** | Sticky Case merge + C1 `graph_execution` from **conversation status** + product template. **No** free-text NLP invent of template. | Maps explicit/sticky structured fields only |
| **Node `resolveHardGraph`** | Product catalog alias / hard file / env / discipline → load Hard Graph (pentest pack only). | Template presence ≈ hard-capable |
| **Node `resolveExpertWorkPath`** | Final path: `chatOnly` / ledger-assist / `continue` → **free**; else hard if hard resolved; else unavailable if intent without hard file; else free. | **Gate table**, not LLM |
| **Goal** | `goal_mode` / `goal_objective` seed GoalStore and free-path outer continues only. | **Does not choose Graph** and does **not** multi-round re-run Graph |

**Today’s product tension (matches map #205 Notes):** picking the Expert seat + default Mode is enough to full-Graph on the first assign **with target/scope**. The Agent never decides “Graph or free” as a judgment step. Post-complete chat is free-in-envelope via C1. Goal does not schedule multi-round Graph.

**Greeting:** cannot full-Graph. No target/scope → UI still may send sticky `engagement_template`, but Node `isChatOnlyTask` forces free path.

---

## 1. End-to-end decision chain (primary)

```text
UI partner + Mode chip
  → user_message { engagement, engagement_template?, goal_mode?, target?, scope? }
  → platform _dispatch_task_assign_to_node
       · merge sticky Case RoE (engagement_template / allow_postex)
       · resolve_graph_execution (C1) → graph_execution?
  → Node normalizeTask
  → session-runner:
       chatOnly / ledgerAssistSeat
       resolveHardGraph(task, pack)
       continueInEnvelope = graphExecution === "continue"
       resolveExpertWorkPath(...)
         ├─ free  → free OMP (freePentestGraphResolution)
         ├─ hard  → runHardGraphExpertTask
         └─ unavailable → task_error (fail-closed)
```

No step in this chain is “Agent (LLM) chose Graph.” Path is **structured fields + chatOnly + conversation status**.

---

## 2. UI — ConversationPage + Expert catalog

### 2.1 Catalog: Expert Graphs only; free is Default seat

Primary: `platform/frontend/src/lib/experts.ts`

- `EngagementTemplateId = "app_assessment" | "redteam_deep"`
- `ENGAGEMENT_TEMPLATES` lists **only** those two chips  
- Comment law: *“free is Default seat only — not listed here”* / *“no Expert free”*

Default seat (`default` / `consult` / `workspace`) never offers Mode chips and never attaches `engagement_template`.

### 2.2 Default `app_assessment` on pentest select

Primary: `platform/frontend/src/pages/ConversationPage.tsx`

| Hook | Behavior |
|------|----------|
| `selectExpertFromToolbar` | Leaving pentest → clear template + Goal. **Entering pentest** without restored template: `setEngagementTemplate((prev) => prev ?? "app_assessment")` |
| `useEffect` on `showPentestControls` | If pentest partner active and `engagementTemplate == null` → set `"app_assessment"` |
| Case restore (`/case`) | Restores only product templates; missing → `null` (then the effect above re-defaults to `app_assessment` while pentest partner is selected) |

So: **any time the composer’s partner is a pentest Expert and no Case sticky template exists, UI state is `app_assessment`.**

### 2.3 Send: when template hits the wire

`handleSend` → `launchTaskMessage`:

```text
isPentest && engagementTemplate  →  engagement_template + allow_postex from chip
isPentest && goalModeEnabled     →  goal_mode: true  (optional goal_objective)
```

Also persists Case RoE via `PUT .../case` when `activeId && isPentest && tmpl`.

**Implication:** once the user has selected (or defaulted into) pentest Expert, **every send** carries the Graph template while the Mode chip stays set — including greetings (template present; target may be absent).

### 2.4 Target gate in UI (greeting vs work burst)

In `launchTaskMessage`:

| Condition | Wire shape |
|-----------|------------|
| No `targetValue` (no opts.target, no URL/IP via `extractTarget`) | `user_message` with engagement / template / goal — **no** `target` / `scope` |
| Has target | `user_message` with structured `target` + `scope.allow` |

`extractTarget` is **URL or IPv4 only** (not free-text “scan the app”). Greetings like “你好” stay target-less.

UI comment: *“No authorized target yet (e.g. 你好): room chat only … Do not open recon work-surface.”*

### 2.5 Mid-run vs completed

- Conversation `running` + existing Case → may `user_steer` (not a new Graph schedule from UI).  
- Restart phrases / completed Case can force fresh conversation handling; C1 post-complete path is primarily **platform status**, not UI inventing `graph_execution`.

---

## 3. Platform — Case sticky + C1 `graph_execution`

### 3.1 Pure helpers (`case_engagement.py`)

| Function | Role |
|----------|------|
| `normalize_product_engagement_template` | Product Graphs only; `free`/`none`/… → **None** (clears sticky Graph) |
| `merge_case_into_context` | Writes Case + task sticky; free clears template / product engagement / pentest role fallback |
| `roe_payload_for_task_assign` | Emits sticky `engagement_template` + `allow_postex` (+ accounts) onto assign |
| `resolve_allow_postex` | Explicit bool wins; else `redteam_deep` → true, else false |
| `resolve_graph_execution` | C1 (below) |
| `focus_fields_from_message` | Dig-deeper ids/note only — not path selection |

**Explicit:** module header — *“Structured fields only — no free-text NLP inventing engagement.”*

### 3.2 C1: `resolve_graph_execution`

```text
explicit full|run|restart     → "full"
explicit continue|continue_chat|envelope → "continue"
else if NOT product Graph template → omit (None)
else if conversation_status in {completed, complete, done} → "continue"
else → omit (None)   # first run: Node treats omit as full when hard resolves
```

Wired in `_apply_graph_execution_c1` (`ws/router.py`) after Case RoE merge on every `_dispatch_task_assign_to_node`.

### 3.3 Sticky merge on assign

`_merge_case_roe_into_task_assign`: if message omits `engagement_template`, fill from Case sticky. If engagement blank but template present, set engagement from template (Node pack alias).

### 3.4 Goal on platform

`_goal_objective_from_message`: only when structured `goal_mode` truthy or explicit `goal_objective`. Default objective string if mode on without custom text. **Never** used to set `engagement_template` or `graph_execution`.

### 3.5 What platform does *not* do

- Does not scan instruction text for “评估 / retest / verify” to invent Graph template (AGENTS.md Intent law).  
- Does not ask the Agent “Graph or free?”  
- Does not auto-loop Goal suggestions into a new Graph run after close-out.

---

## 4. Node — resolveHardGraph + resolveExpertWorkPath

### 4.1 Entry: `session-runner.ts` `runNode4Task`

Order:

1. Pack resolve (`resolveRolePack`)  
2. `chatOnly = isChatOnlyTask(task, pack.id)`  
3. `ledgerAssistSeat = isLedgerAssistSeat(pack.id)`  
4. `hardResolved = await resolveHardGraph({ task, packRoot, packId, env })`  
5. `continueInEnvelope = isContinueInEnvelopeExecution({ graphExecution })`  
6. `workPath = resolveExpertWorkPath({ hardMode, graphIntent: resolveGraphIdFromTask(task), chatOnly, ledgerAssistSeat, continueInEnvelope })`  
7. Branch: hard → `runHardGraphExpertTask`; unavailable → `task_error`; else free OMP  

### 4.2 `isChatOnlyTask` / ledger assist

```text
pack default|consult|workspace     → always chatOnly (+ ledger assist)
else: empty target value AND empty scope.allow → chatOnly
else → not chatOnly
```

**Greeting with pentest + sticky `app_assessment` but no target/scope → free path**, even though hard definition *could* load.

### 4.3 `resolveHardGraph` (`hard-graph-definition.ts`)

| Condition | Result |
|-----------|--------|
| `packId` set and not `pentest` | `not_hard` |
| `graphId` / `engagementTemplate` maps via product catalog **hardId** (e.g. `app_assessment`, `redteam_deep`, thin/lab aliases) | load `graphs/hard/{hardId}.json` → `hard` |
| `graphDiscipline === "hard"` or env `NODE4_HARD_GRAPH` | default hard id `app_assessment` if no alias |
| raw id with hard file under pack | `hard` |
| else | `not_hard` |

Product catalog (phase 2): `app_assessment` and `redteam_deep` both have `hardId` set — UI product templates are full Expert Graph loaders.

### 4.4 `resolveGraphIdFromTask` (intent, fail-closed)

Candidates: `graphId`, `engagementTemplate`, then `engagement`/`role` **only if** they are known Graph templates (skips bare `pentest` / `ctf` / `default` / free aliases).

Non-null intent + no hard file → `resolveExpertWorkPath` → **`unavailable`** (never silent free Soft).

### 4.5 `resolveExpertWorkPath` (final binary)

| Priority | Condition | Path |
|----------|-----------|------|
| 1 | `chatOnly` or `ledgerAssistSeat` | **free** |
| 2 | `continueInEnvelope` (`graphExecution === "continue"` after parse) | **free** (C1 free-in-envelope; sticky RoE may remain) |
| 3 | `hardMode === "hard"` | **hard** |
| 4 | `graphIntent` non-null | **unavailable** |
| 5 | else | **free** |

`parseGraphExecution`: `continue` / `continue_chat` / `envelope` → continue; `full` / `run` / `restart` → full; omit → undefined (not continue).

### 4.6 Free path after branch

`freePentestGraphResolution` always returns `mode: "free"` (Soft scenario inject retired). RoE `allowPostex` from envelope only.

---

## 5. Scenarios (truth table)

| Scenario | Wire (gist) | Node path | Full Graph stages? |
|----------|-------------|-----------|--------------------|
| Default seat “你好” | engagement=default, no template, no target | chatOnly + ledger → free | No |
| Pentest Expert, default Mode, “你好” | engagement≈pentest, **engagement_template=app_assessment**, no target | chatOnly → **free** (template sticky unused for stages) | **No** |
| Pentest Expert, default Mode, first send with URL/target | template=app_assessment, target+scope, status not completed, graph_execution omit | hard resolved, not continue → **hard** | **Yes** |
| Same, Mode = 红队深度 | template=redteam_deep, allow_postex true | hard (deep graph) | **Yes** |
| After Graph **completed**, follow-up with sticky template + target | platform sets **graph_execution=continue** | hard loadable but continueInEnvelope → **free** | **No** (envelope chat) |
| Completed + explicit `graph_execution=full` | full wins over status | hard path | **Yes** (re-run) |
| Goal ON + target + app_assessment first run | goal_mode + template + target | **hard** (Goal ignored for path) | **Yes** |
| Goal ON free OMP (no template / Default) | goal_mode only | free; Goal outer continues | No Graph |
| Non-pentest Expert pack | no product hard catalog | not_hard → free (or no Graph intent) | No |

---

## 6. Goal’s role today (non-role for path)

| Layer | Behavior |
|-------|----------|
| UI | Toggle sets `goal_mode: true` on send for pentest only; does **not** change Mode chip or template |
| Platform | Maps structured goal fields onto `task_assign`; default objective constant if mode without custom text |
| Node free OMP | `GoalStore` + `evaluateContinueAfterSegment(... goalModeActive ...)` — **same-task** outer continues / budget |
| Node Hard Graph | Goals may exist on parent runtime; **no** Goal-driven multi-round Graph reschedule or “adopt suggestions until empty” loop |

**Map #205 Goal-loop is greenfield relative to path selection:** today Goal is an **in-burst harness flag**, not a Graph scheduler and not a substitute for Agent Graph intent.

---

## 7. Answers to ticket specials

### 7.1 Default `app_assessment` on pentest select

**Yes, in product UI.** Toolbar select + effect default Mode to `app_assessment`. Expert free chip does not exist; free is Default seat. Spec language (`docs/specs/task-graph.md` / `harness.md`) still says casual → Default and UI default free in places — **product ConversationPage contradicts “Expert free”** by design of S2/U1 (#78): Expert path is Graph chips only.

### 7.2 Can greeting full-Graph?

**No.** Target/scope absence ⇒ UI omits target; Node `isChatOnlyTask` ⇒ free. Sticky template may still be written to Case on send, so a **later** targeted assign can full-Graph without re-picking Mode.

### 7.3 Goal’s role in path selection

**None.** Goal does not enter `resolveHardGraph` / `resolveExpertWorkPath` / `resolve_graph_execution`.

---

## 8. Gaps vs map #205 Destination (facts only)

Destination wants: **Agent may choose Graph or stay free**; seat pick must not force Graph; Goal adopts round suggestions until empty.

| Today | Destination tension |
|-------|---------------------|
| Seat + default Mode ⇒ structured template always on pentest sends | Agent intent not consulted |
| First targeted assign with sticky template ⇒ full Graph | No “optional Graph” gate |
| C1 continue after complete | Continue is free-in-envelope, not Goal multi-round Graph |
| Goal = free-path continue budget | Not “adopt suggestions → new Graph until none” |
| Platform correct on NLP invent | UI still **pre-fills** structured Graph intent |

This research does **not** prescribe the handoff design (host prompt vs Agent-set template) — that remains map #205 Not-yet-specified.

---

## 9. Primary-source index

| Source | Path |
|--------|------|
| UI defaults + send | `platform/frontend/src/pages/ConversationPage.tsx` |
| Template catalog | `platform/frontend/src/lib/experts.ts` |
| Case / C1 pure | `platform/backend/app/services/case_engagement.py` |
| C1 tests | `platform/backend/tests/test_case_engagement.py` |
| Assign + merge + C1 apply | `platform/backend/app/ws/router.py` (`_dispatch_task_assign_to_node`, `_apply_graph_execution_c1`, `_merge_case_roe_into_task_assign`, `_goal_objective_from_message`) |
| Task normalize | `node4/src/main.ts` (`normalizeTask`) |
| Hard resolve + work path | `node4/src/runtime/hard-graph-definition.ts` |
| Intent + free resolution | `node4/src/runtime/pentest-graph.ts` |
| Path branch | `node4/src/runtime/session-runner.ts` (`runNode4Task`, `isChatOnlyTask`, `isLedgerAssistSeat`) |
| C1 Node contract tests | `node4/src/runtime/continue-chat-c1.test.ts`, `hard-graph-definition.test.ts` |
| Product law (modes) | `docs/specs/task-graph.md`, `docs/specs/harness.md` |
| Intent law | `AGENTS.md` (Intent And Workflow Selection) |

---

## Resolution gist (for map #205 Decisions)

**Today Graph is chosen by UI sticky Expert Mode (default `app_assessment` on pentest), not by Agent judgment.** Wire `engagement_template` → platform Case sticky + optional C1 `graph_execution` → Node `resolveHardGraph` / `resolveExpertWorkPath`. Greeting without target is free (`chatOnly`); first targeted assign with product template is full Hard Graph; post-complete sticky+status is free-in-envelope (`continue`). **Goal does not select path and does not multi-round Graph.** Spec free-as-default lives on Default seat; Expert UI has no free chip.
