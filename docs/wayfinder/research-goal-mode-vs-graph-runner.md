# Research: Goal mode runtime vs Graph runner

> Ticket: GitHub **#207** · Map **#205** (Agent-chosen Graph + Goal multi-round suggestion loop)  
> Repo sources only — **no product feature code** in this resolution.  
> Date: 2026-07-28 · branch `research/goal-mode-vs-graph-runner` (base main `3378b8c`)

## Question

What does Goal mode **actually** do today (goal store, auto-continue, complete gates, interaction with Hard Graph stages and `task_complete`)? Can it schedule a **second** full Graph run?

Primary sources: `docs/prd.md`, `docs/specs/harness.md`, `docs/specs/task-graph.md`, platform Goal wire + `graph_execution` C1, Node4 `GoalStore` / `loop-policy` / free `session-runner` / Hard Graph path.

Deliverable: fact matrix for map #205 Destination (Goal-loop adopts round suggestions until empty) — seams to extend vs invent.

---

## Executive answer

| Area | Maturity | Verdict for #205 |
|------|----------|------------------|
| **Goal wire (`goal_mode` / `goal_objective`)** | **Shipped** | Structured-only seed into free OMP; sticky on Case task blob / resume |
| **`GoalStore` + `goal` tool** | **Shipped (free path)** | Single objective status machine; create/complete/drop/pause/resume; progress telemetry |
| **Outer `goal_continuation` inject** | **Lab-only** | Product default **`NODE4_MAX_GOAL_CONTINUES` unset → 0 = OFF**; lab `unlimited`\|N |
| **Complete gates** | **OMP free in code** | No hard audit fields by default; lab `NODE4_GOAL_REQUIRE_CLEARANCE=1` (+ optional min continues/stalls) |
| **Hard Graph interaction** | **Orthogonal / non-coupled** | Hard path **returns before** free outer-continue loop; stages use **fresh empty** `GoalStore`; product stage `tools.allow` **never includes `goal`** |
| **`task_complete`** | **Harness-owned** | Independent of goal status; free path may settle with `open_goals > 0`; Hard settle does not report goals |
| **Second full Graph under Goal** | **Missing** | **No** — Goal never sets `graph_execution=full`, never re-enters Hard runner after settle, never adopts next-scope / close-out suggestions into a new Graph burst |

**One sentence:** Today Goal is an **OMP free-path long-task anchor** (seed + optional lab auto-continue + free complete). Expert **Hard Graph owns stage order and settles once**. Map #205’s “Goal multi-round Graph until no suggestions” is a **new product loop** — not a switch flip on current Goal mode.

---

## 1. Primary-source inventory

### 1.1 Product law (docs)

**`docs/prd.md`**

- Optional Goal mode for execution experts; independent of participant selection.
- Wire: `goal_mode` / `goal_objective` — long-task objective anchor; not NLP on free text.
- Task ends with harness `task_complete` (no agent finish tool).

**`docs/specs/harness.md`**

- Product default: **no outer empty / premature / goal inject** — settle on natural stop after in-loop tools. Lab re-enables via `NODE4_MAX_*`.
- `goal` tool: long-task objective; **product default no outer `goal_continuation`** (`NODE4_MAX_GOAL_CONTINUES` unset/0). Lab: `unlimited` or positive cap. `complete` free in code (active \| budget-limited); honesty prompt-steered. Lab hard audit: `NODE4_GOAL_REQUIRE_CLEARANCE=1`.
- Open goals do **not** invent product findings.
- Free vs Expert Graph: product Expert Graph templates → Hard runner; Soft retired; C1 continue-chat after Graph complete.

**`docs/specs/task-graph.md`**

- After Graph `task_complete`, same-session follow-ups stay in Graph envelope **without auto full re-run (C1)**.
- Structured `graph_execution=continue` → free-in-envelope; full re-run requires explicit `graph_execution=full` (or first-run omit when hard resolves).

**`docs/specs/expert-offers.md`**

- Composer Goal mode: optional long-task switch (+ objective) for execution experts.

### 1.2 Platform: Goal wire

| Piece | Path | Behavior |
|-------|------|----------|
| UI toggle | `platform/frontend/.../ConversationPage.tsx` | Pentest only; sends `goal_mode: true` (+ optional `goal_objective`) on `task_assign` |
| Schedules | `SchedulesPage` / `schedule_tasks.py` | Structured `goal_mode` / `goal_objective` on timed dispatch |
| Build assign | `ws/router.py` `_goal_objective_from_message` | Structured only — **never invent from instruction NLP** |
| Default objective | `DEFAULT_GOAL_OBJECTIVE` in `router.py` | Used when `goal_mode` on without custom text |
| Sticky | `_remember_conversation_task` | Persists `goal_objective` on Case `context.task` |
| Resume | `_resume_message_from_context` | Re-seeds prior goal unless message overrides |

**Note (string lag):** platform `DEFAULT_GOAL_OBJECTIVE` still mentions lab-style `audit_notes` / `remaining_unsolved=0` / harness progress gates. Node default complete is OMP-free unless lab env gates are on — product honesty is prompt-steered, not those hard fields.

### 1.3 Platform: Graph execution (C1) — not Goal

| Piece | Path | Behavior |
|-------|------|----------|
| Resolve | `case_engagement.resolve_graph_execution` | Explicit `full`\|`continue` (synonyms) **or** product Graph template + conversation `completed` → **`continue`** |
| Attach | `_apply_graph_execution_c1` | Writes `graph_execution` on `task_assign` |
| Law | Structured only | Never NLP on free-text instruction |

C1 means: after Expert Graph completed, sticky template **must not** full-run Hard stages on the next chat turn unless caller sets `graph_execution=full`.

**Goal fields do not appear in `resolve_graph_execution`.**

### 1.4 Node4: GoalStore + tool

| Piece | Path |
|-------|------|
| Store | `node4/src/stores/goal.ts` |
| Tool | `node4/src/tools/goal.ts` |
| Policy | `node4/src/runtime/loop-policy.ts` |
| Free loop | `node4/src/runtime/session-runner.ts` |
| Envelope | `node4/src/main.ts` normalize → `task.goalObjective` |
| Types | `node4/src/types.ts` `goalObjective` |

**Status machine:** `active` \| `paused` \| `budget-limited` \| `complete` \| `dropped`.

| Mechanism | Behavior |
|-----------|----------|
| `isActive()` | **Only** `status === "active"` (budget-limited / paused do **not** auto-continue) |
| `create` | One non-terminal goal per store; optional `token_budget` |
| Token accounting | `addTokensUsed` → may flip to `budget-limited` + one-shot wrap-up steer |
| `tryComplete` | Default: free for active \| budget-limited; paused/complete/dropped blocked |
| Lab gates | `NODE4_GOAL_REQUIRE_CLEARANCE`, `NODE4_GOAL_MIN_CONTINUES`, `NODE4_GOAL_MIN_STALLS`, audit length |
| Progress | `noteSegmentProgress` / stall counter / `goalContinueCount` (telemetry) |
| Platform events | `goal_updated` on create/complete/drop/pause/resume (and complete_rejected) |

### 1.5 Outer auto-continue policy (free path only)

`resolveOuterContinueBudgets`:

| Env | Product default | Lab |
|-----|-----------------|-----|
| `NODE4_MAX_CONTINUES` | **0** | positive |
| `NODE4_MAX_EMPTY_STOPS` | **0** | positive |
| `NODE4_MAX_PREMATURE_STOPS` | **0** | positive |
| `NODE4_MAX_GOAL_CONTINUES` | **unset → 0 (off)** | `unlimited` or N |

`goalContinuationAllowed`: inactive → false; max 0 → false; omit/non-finite → unlimited (lab); positive → hard cap.

`shouldContinueAfterNaturalStop` priority (when budgets allow): abort → booking_gap → empty-stop recovery → **if goal active + allowed → `goal_continuation`** (bypasses outer `maxContinues`) → premature → natural stop.

**Product consequence:** even with UI Goal ON and seed objective active, **no outer goal inject** unless lab env enables it. Agent must keep multi-tool work **in-loop** (pi agent-loop) or stop → settle.

### 1.6 Free OMP session-runner wiring

On free path only:

1. Create parent `GoalStore`.
2. If not chat-only: seed from `task.goalObjective` **else** `pack.defaultGoalObjective` (e.g. CTF maximize flags).
3. Outer continue loop uses `goals.isActive()` + budgets.
4. On goal kind: inject `buildGoalContinuationPrompt` (completion-audit steer).
5. Settle: `task_complete` with `open_goals`, optional `attack_surface_candidates` / `next_scope_candidates` (T-host OOS). **Does not require goal complete.**

Pentest pack `settlementNote` (law): open goals/todos do not block completed when findings are booked.

### 1.7 Hard Graph path — Goal is bypassed

`session-runner` order of operations:

```text
build parent ToolRuntime (includes empty GoalStore)
  → resolveHardGraph + resolveExpertWorkPath
  → if path === "hard":
       runHardGraphExpertTask(...)   // EARLY RETURN
       // never reaches: free outer-continue loop
       // never reaches: goals.create(seedObjective)
```

`hard-graph-task.ts` header: **“Outer continues do not apply.”**

Stage captain (`buildHardGraphStageChildRuntime`):

- **`goals: new GoalStore()`** — fresh empty store per stage (not parent seed, not task objective).
- Single `session.prompt(userPrompt)` — **no** `evaluateContinueAfterSegment` / goal_continuation loop.
- Product Hard stage `tools.allow` lists (**app_assessment**, **redteam_deep**, thin): **`goal` never allowed** (even though pack.json lists `goal` for free path).

Settlement (`settleHardGraphTask`):

```text
task_complete {
  status: completed|incomplete|blocked,
  stop_reason: hard_graph_<terminal>,
  continue_count: 0,
  booked_findings,
  work_mode: hard_graph:...:terminal:...,
  // no open_goals
  // no attack_surface_candidates / next_scope_candidates
}
```

Engagement close-out (`engagement_closeout`) carries residual_risk / honesty residual — **not** a Goal loop worklist and **not** auto-fed into a second Graph schedule.

### 1.8 Work-path matrix (structured only)

From `resolveExpertWorkPath` + C1:

| Inputs | Path |
|--------|------|
| Default / chatOnly / ledger assist | free |
| `graph_execution=continue` | **free-in-envelope** (sticky Graph RoE/template, **no Hard stages**) |
| Hard resolves + not continue | **Hard Graph runner** |
| Graph intent but hard missing | unavailable (fail-closed) |
| No Graph intent | free OMP |

**Goal mode is not an input to this table.**

---

## 2. Behavior matrix: Goal × Graph × settle

### 2.1 Product Expert pentest + Goal ON + first Graph (typical UI)

```text
UI: pentest + engagement_template=app_assessment + goal_mode=true
  → task_assign: goal_objective + goal_mode + template
  → Node hard resolves → runHardGraphExpertTask
  → Goal seed SKIPPED; stages no goal tool; outer continue N/A
  → settleHardGraphTask → task_complete
  → Case status completed
```

**Effect of Goal UI switch on Expert Graph first run: wire + sticky task blob only.** Runtime Goal auto-continue and complete gates do **not** drive the Graph.

### 2.2 Same Case, post-Graph chat (C1)

```text
conversation completed + sticky product template
  → resolve_graph_execution → graph_execution=continue
  → free-in-envelope (OMP Main under Graph envelope fields)
  → NOW goal seed can apply if goal_objective present
  → outer goal_continuation still product-OFF unless lab env
  → free settle may emit next_scope (T-host) if free path books locations
```

This is **not** “second full Graph.” Explicit `graph_execution=full` (or equivalent structured re-entry) is required for Hard re-run.

### 2.3 Free OMP / CTF / lab bare + Goal

| Seat | Goal seed | Outer goal continue (product) | Outer goal continue (lab unlimited) |
|------|-----------|-------------------------------|-------------------------------------|
| Free Expert (no Graph template) | task or pack default | off | while active |
| CTF pack | defaultGoalObjective common | off | while active |
| Lab bare `runtime` | agent create or seed | off unless env | designed for unbounded OMP |
| Default seat | chat-only — no seed | n/a | n/a |

### 2.4 `goal(complete)` vs `task_complete`

| Event | Owner | Effect |
|-------|-------|--------|
| `goal(complete)` accepted | Agent tool + GoalStore | Deactivates auto-continue (when lab inject on); emits `goal_updated` |
| `goal(complete)` rejected | Lab gates or status machine | `complete_rejected`; work continues |
| Natural stop + product budgets 0 | Harness | Settle **even if goal still active** |
| Abort / cancel | Platform / user | Settle incomplete-ish path |
| Hard Graph terminal | Hard runner + settleHardGraphTask | Single `task_complete`; goals unused |

There is **no** harness rule: “active goal ⇒ refuse task_complete” or “goal complete ⇒ start next Graph.”

---

## 3. Can Goal schedule a second full Graph run?

### 3.1 Direct answer

**No.** Primary sources show **zero** linkage from GoalStore / goal tool / goal_mode to:

- `graph_execution=full` emission  
- `runHardGraph` re-entry  
- platform auto-`task_assign` of a new Hard burst  
- adoption of next-scope / close-out / residual suggestions into a new Graph prompt  

### 3.2 What exists that people might confuse with it

| Mechanism | What it is | Not Goal multi-round Graph |
|-----------|------------|----------------------------|
| C1 `graph_execution=continue` | Free-in-envelope chat after Graph complete | Explicitly **not** full stage schedule |
| Explicit `graph_execution=full` | Structured full re-run | Caller/platform field; Goal does not set it |
| Next-scope UI (T-host) | User confirm → new task / scope.allow | Free-path candidates; Hard settle silent; user-driven |
| Engagement close-out residual | Product report of residual risk / honesty | Not auto-loop worklist |
| Lab outer goal_continuation | Re-prompt **same** free session | Same taskDir burst; not Graph stages |
| Stage max_retries / L1 refine | Hard stage repair loops | Inside one Graph run; not Goal |

### 3.3 Gap vs map #205 Destination (Goal-loop)

Map #205 wants: under Goal, **adopt each round’s Graph/Case suggestions** and **continue** (new Graph run or equivalent) **until a round emits no further suggestions**.

| Requirement | Today |
|-------------|-------|
| Agent-chosen Graph vs free | Partially structural (template fields); UI still sticky defaults — map G-intent separate |
| Goal drives multi-round Graph | **Absent** |
| Adopt suggestions automatically under Goal | **Absent** (next-scope is user confirm; Hard silent on candidates) |
| Stop when no suggestions | No Goal-linked empty-suggestion gate |
| Suggestion quality at Graph close-out | Close-out + free next-scope exist; not Goal-loop SoT |

**Seam recommendation (research only — not implementation):**

1. Treat Goal multi-round Graph as a **platform/Case orchestrator** (or explicit host policy) that consumes **Case next-scope family / close-out proposals** (#197 maps) and issues **new** `task_assign` with structured `graph_execution=full` + composed prompt — **not** as extending free-path outer goal_continuation into Hard stages.  
2. Do **not** overload in-stage empty `GoalStore` or lab `goal_continuation` to mean “schedule next Graph.”  
3. Keep C1 free-in-envelope for dig-deeper chat; full re-run remains explicit structured field.  
4. Product outer goal inject staying OFF is compatible if multi-round is **burst-level** (task_complete → new assign), not mid-burst inject.

---

## 4. Complete gates (detail)

### 4.1 Product / OMP default

From `GoalStore.completeBlockers` / `tryComplete`:

- Structural only: no goal / already complete / dropped / paused.  
- **active** and **budget-limited** may complete.  
- `audit_notes` / `remaining_unsolved` optional; not required.  
- Honesty: continuation / active / budget-limit **prompts** (`buildGoalContinuationPrompt`, `buildGoalActiveContext`).

### 4.2 Lab optional hard gates

| Env | Effect |
|-----|--------|
| `NODE4_GOAL_REQUIRE_CLEARANCE=1` | Require long `audit_notes`, `remaining_unsolved=0` |
| `NODE4_GOAL_MIN_CONTINUES` | Need N outer goal_continuation injects first |
| `NODE4_GOAL_MIN_STALLS` | Need N no-progress segments |

These are **not** product Expert Graph gates (Hard uses stage L0/L1 / empty-book / package honesty — separate system).

### 4.3 Budget soft stop

`token_budget` exhausted → `budget-limited` → `isActive()=false` → auto-continue stops; one-shot wrap-up steer; complete still allowed if evidence truly done.

---

## 5. Interaction summary diagram

```text
                    ┌─────────────────────────────┐
  task_assign       │  resolveExpertWorkPath      │
  goal_mode?        │  (goal fields ignored)      │
  template?         └──────────┬──────────────────┘
  graph_execution?             │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
     path=hard                         path=free (or C1 continue)
  runHardGraphExpertTask               session-runner free loop
  · no goal seed                       · seed GoalStore from objective
  · stage GoalStore empty              · product: outer goal inject OFF
  · no goal tool on stages             · lab: goal_continuation while active
  · outer continues N/A                · goal(complete) only stops auto-cont.
  · settleHardGraphTask                · task_complete may leave open_goals
  · no next_scope on complete          · may emit next_scope (T-host)
              │                                 │
              └──────────── task_complete ──────┘
                              │
              platform Case status; C1 next turn = free-in-envelope
              Goal does NOT auto-issue graph_execution=full
```

---

## 6. Seams: extend vs invent (for #205 Spec later)

| Need | Prefer | Avoid |
|------|--------|-------|
| Multi-round Expert Graph | New Case/platform loop + structured `graph_execution=full` + Case suggestions (#197) | Pretending free `goal_continuation` is Graph scheduling |
| Goal as “keep going” policy | Explicit product policy flag on orchestrator (“auto-adopt under Goal”) | Keyword NLP inventing engagement |
| Stop when no suggestions | Define empty suggestion contract on close-out / next-scope family | Inferring from goal(complete) alone |
| Free dig-deeper after Graph | Keep C1 continue-in-envelope | Forcing full re-run on every chat |
| Stage-level long objective | (Optional) seed stage prompt text from Case objective — **prompt only** | Enabling `goal` tool + outer continue inside Hard stages without Spec |
| Product default outer inject | Keep OFF; multi-round = new bursts | Turning `NODE4_MAX_GOAL_CONTINUES=unlimited` as product Goal-loop |

---

## 7. Risks and non-goals

**Risks if #205 is misread against today’s code:**

1. **UI Goal ON on Expert Graph** looks like multi-round but only stores objective — user expectation mismatch.  
2. Enabling lab `NODE4_MAX_GOAL_CONTINUES` on free path still **never** re-enters Hard Graph.  
3. Platform default objective text still describes lab clearance fields → agent confusion if mixed with OMP-free complete.  
4. Hard settle silence on next-scope (#198/#199) already blocks honest Goal-loop even after a scheduler exists.

**Non-goals of this note:** product code; Case next-scope schema (#197); permission OS; Soft Graph resurrection; expected vuln counts.

---

## 8. Resolution (ticket #207)

1. **Goal mode today** = structured objective seed + in-process `GoalStore` / `goal` tool on **free OMP**; optional **lab-only** outer auto-continue while `active`; OMP-free complete (lab optional hard gates). Product outer inject is **off**.  
2. **Hard Graph** does **not** use Goal auto-continue, does **not** seed parent objective into stages, does **not** allow `goal` on product stage tool profiles, and settles via **`settleHardGraphTask`** independent of Goal.  
3. **`task_complete`** is always harness/platform settlement; Goal open/complete does not schedule work and does not block free settle.  
4. **Goal cannot schedule a second full Graph run** today. C1 is free-in-envelope; full re-run is explicit `graph_execution=full` from structured policy, not Goal.  
5. Map **#205 Goal-loop** requires a **new** Case/platform multi-burst orchestrator over suggestions — extend Case next-scope / close-out + explicit Graph re-entry; **do not** invent by reinterpreting free-path Goal continuation as Graph runner control.

---

## 9. Source index (absolute paths)

| Topic | Paths |
|-------|--------|
| Goal store / prompts | `/mnt/d/Coding/my-ai-pen/node4/src/stores/goal.ts` |
| Goal tool | `/mnt/d/Coding/my-ai-pen/node4/src/tools/goal.ts` |
| Outer continue policy | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/loop-policy.ts` |
| Free path seed + settle | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/session-runner.ts` |
| Work path + parseGraphExecution | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-definition.ts` |
| Hard task + no outer continues | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-task.ts` |
| Hard settle | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-settlement.ts` |
| Stage empty GoalStore | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-stage-executor.ts` |
| Envelope normalize | `/mnt/d/Coding/my-ai-pen/node4/src/main.ts` |
| Platform goal + C1 | `/mnt/d/Coding/my-ai-pen/platform/backend/app/ws/router.py`, `.../case_engagement.py` |
| Specs | `/mnt/d/Coding/my-ai-pen/docs/specs/harness.md`, `task-graph.md`, `prd.md` |
| Hard stage tool allow | `/mnt/d/Coding/my-ai-pen/experts/pentest/graphs/hard/*.json` |
