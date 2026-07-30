# Research: Worker identity continuity (multi-package, idle pool, Tasks)

> Ticket: GitHub **#255** · Map **#253** (Worker process audit / collaboration dialog Spec)  
> Repo sources only (AFK research — no product feature code).  
> Date: 2026-07-30

## Question

How does a **Worker identity** behave today across **multiple Packages**, session reuse, and **Tasks** linkage — relative to the charting lock **“one tree node = continuous conversation thread”**?

## Executive answer (facts)

| Dimension | Today |
|-----------|--------|
| Stable id | Subagent host id (`sub_${Date.now()}_${seq}` cold; **same id** on warm `resume_agent_id`) |
| Roster row | **One** `panel_agents` child per id (`Map` upsert). Multi-package on same id **overwrites** `task` / status / detail — does **not** add a second tree row |
| Display name | `Worker N` from per-task `PanelAgentTracker.workerIndexById` (first-seen ordinal). Resume **keeps N**. No Case-level rename field/API |
| Idle pool | In-memory per parent task lifecycle; **explicit** `resume_agent_id` + same-path affinity; not auto path-grab. Park success/soft-fail; release on abort/TTL/maxPackages/LRU/task end |
| Tasks chip | L2: `agent_id` + `linked_agent_id` + `owner_agent_name` via bind path `explicit → reattach → single_free → fuzzy → pkg-*` |
| Stacked packages in one dialog | **Not productized.** Package tool streams are **suppressed** from Case chat; no Worker-scoped dialog; warm package clears intentional settlement files in shared `workDir` |
| Charting lock fit | Identity continuity (same id / same tree node / same Worker N) **exists** when Main resumes. Continuous multi-package **transcript** for audit dialog **does not** exist as a product surface |

---

## 1. `panel_agents` / `PanelAgentTracker` — stable Worker N and ids

**Primary:** `node4/src/runtime/panel-agents.ts`, `node4/src/runtime/subagent.ts`

### 1.1 Record shape

`PanelAgentRecord`: `id`, `name`, `status`, `parent_id`, `task`, `skills`, `pending_count`, `role`, optional `current_tool` / `current_action` / `current_detail` / `outcome` / `error` / `goal_id`.

Main row: fixed id `"node4-main"`. Children: `parent_id: "node4-main"`, `role: "subagent"`.

### 1.2 Worker index (ordinal)

```ts
// PanelAgentTracker
private readonly workerIndexById = new Map<string, number>();
private workerSeq = 0;

workerIndexFor(id: string): number {
  // empty id → ++workerSeq (no stable map entry)
  // else: return existing or assign ++workerSeq
}
```

- Comment in source: **“Stable Worker 1..N index per subagent id (resume keeps the same number).”**
- Display name: `formatWorkerName(n)` → `` `Worker ${n}` `` (or bare `"Worker"` if invalid).

### 1.3 Start / end lifecycle on the roster

| Call | Effect on `children` Map |
|------|--------------------------|
| `noteSubagentStart({ id, assignment, label, … })` | `children.set(id, {…})` — status `running`; `name = formatWorkerName(workerIndexFor(id))`; `task` / `current_detail` from `resolveSubagentGoal(label, assignment)` |
| `noteSubagentEnd({ id, ok, summary })` | **Same id** overwritten: status `completed`/`failed`; preserves prior `name` when present; detail becomes completion/failure text |

`list()` returns `[main, ...children.values()]`. Running child count can rewrite Main `current_detail` to `并行 N 个 Worker`.

**Implication for multi-package:** same `id` → **one roster row**, latest package goal overwrites `task`. Different cold ids → multiple rows (`Worker 1`, `Worker 2`, …).

### 1.4 Who owns the tracker

| Path | Construction |
|------|----------------|
| Free OMP | `session-runner.ts`: one `PanelAgentTracker` per task; `lifecycle.panelAgents` |
| Expert Graph | `hard-graph-task.ts`: run-level `panel` on `lifecycle.hardGraphRun.panel` + `panelAgents`; stages **reuse** the same instance (`hard-graph-stage-executor.ts` prefers `graphRun.panel` / `parentRuntime.lifecycle.panelAgents`) |

Ordinals are **per tracker instance / task run**, not Case-global. Case history merge is separate (below).

### 1.5 Host emit path

`SubagentHost.spawn` (`node4/src/runtime/subagent.ts`):

1. Resolve id: `options.subagentId?.trim() || \`sub_${Date.now()}_${++subSeq}\``
2. `panelAgents.noteSubagentStart` → `emitPanelAgentsSnapshot` (`status_update` + `checkpoint_update` with `panel_agents`)
3. Hard Graph chip upsert (Tasks)
4. `subagent_started` (includes `panel_agents`)
5. Worker runs
6. `noteSubagentEnd` → snapshot again → chip terminal → `subagent_finished`

Warm resume passes `subagentId: warmHandle.agentId` from the tool layer (`node4/src/tools/subagent.ts`), so start/end reuse the **same** id and **same** Worker N.

---

## 2. Idle pool / `session_reuse` — same id vs new Worker

**Primary:** `node4/src/runtime/subagent-idle-pool.ts`, `node4/src/runtime/subagent-session.ts`, `node4/src/tools/subagent.ts`

### 2.1 Pool lifecycle

- Enabled unless `NODE4_SUBAGENT_IDLE` is `0`/`false`/`off`/`no`.
- Lazy attach: `getOrCreateIdlePool(runtime.lifecycle)` → `lifecycle.subagentIdlePool`.
- Defaults: `maxIdle=8`, `ttlMs=420_000` (7 min), `maxPackages=4` (env overridable).
- Keyed by **`agentId`**, not path. Path is affinity metadata on the handle.
- `tryTake(pathKey)` is **deprecated and always returns undefined** (no auto path grab).
- Task end / abort: `session-runner.ts` calls `subagentIdlePool.disposeAll()`.

### 2.2 When id is reused (warm)

Tool layer (`runSubagentPackage`):

1. Read `pkg.resume_agent_id`.
2. If set and not `command` shell package: `pool.tryResume(resumeWanted, { pathKey, nodeType, skillId })`.
3. Affinity (`checkAffinity`): same non-empty `pathKey` required; skill mismatch when both set rejects; `packagesCompleted >= maxPackages` → reject; idle TTL exceeded → reject/release.
4. On success: `spawn({ subagentId: warmHandle.agentId, …, warmHandle })`.
5. `runWarmPackage`: re-prompts **live** `session`; increments `packagesCompleted`; re-parks unless parent abort.

`session_reuse` on warm success:

```text
{ hit: true, agent_id, path_key, packages_completed, parked, worker_status, … }
```

Cold park after first package:

```text
{ hit: false, agent_id, path_key, packages_completed: 1, parked, worker_status }
```

Shell-only packages: `session_reuse: { hit: false, agent_id, shell: true }` (no LLM keep-alive).

### 2.3 When a new Worker is created

| Condition | Result |
|-----------|--------|
| No `resume_agent_id` | Cold spawn → new `sub_*` id → new Worker N |
| Resume rejected (`not_found`, `path_mismatch`, `skill_mismatch`, `expired`, `max_packages`, `disabled`, `command_package`) | Cold spawn with **new** id; `session_reuse.resume_reject` set when hit is false |
| Parent abort during package | `worker_status=released`; session disposed; not re-parked |
| Idle TTL / LRU / maxPackages / `release` / `disposeAll` | Handle gone; later resume → `not_found` → new Worker |

Main is instructed (tool description) to pass `resume_agent_id` for same-path gap/timeout follow-up when `worker_status=idle`. Continuity is **opt-in by Main**, not automatic.

### 2.4 Shared workDir on warm

Warm uses `warmHandle.workDir` (same `taskDir/subagents/{agentId}`). Before re-prompt, `clearIntentionalStructuredFiles(workDir)` unlinks intentional settlement artifacts for the new package. Host still writes `result.json` for **that** package completion under the same path (latest wins on disk).

---

## 3. Tasks binding — `owner_agent_name`, `linked_agent_id`, `plan_node_id`

**Primary:** `node4/src/runtime/subagent.ts` (`upsertHardGraphPackageChip`), `node4/src/runtime/hard-graph-plan.ts`, FE `TasksPlanList.tsx` / `panelTypes.ts`

### 3.1 Chip fields written by host

On package start/end (when `hardGraphPlan` + `stageId` present):

```ts
const workerN = panelAgents?.workerIndexFor(subagentId) ?? 0;
const owner = workerN > 0 ? formatWorkerName(workerN) : "Worker";
// chip:
{ agent_id: subagentId, owner_agent_name: owner, status, goal, plan_node_id }
```

`applyChip` sets on the L2 row:

- `agent_id = input.agent_id`
- `owner_agent_name = input.owner_agent_name`
- `linked_agent_id = input.agent_id` (**same as agent_id**)
- optional `status` → normalized plan work status (`running` / `done` / `failed`)

### 3.2 Bind priority (`resolveWorkerBind`)

1. **`explicit`** — `plan_node_id` / `todo_node_id` present and found: `attachWorker(stageId, nodeId, …)` (rejects `pkg-*` ids).
2. **`reattach`** — existing L2 row with `agent_id` or `linked_agent_id` === this agent (non-`pkg-*`); updates chip/status; **does not steal another agent’s row**.
3. **`single_free`** — exactly one unbound Main L2 row (no `agent_id`, not `pkg-*`).
4. **`fuzzy`** — free or same-agent row; title↔goal score ≥ threshold.
5. **`pkg`** — fallback host row `pkg-${subagentId}` via `upsertStageWorkItem`.

Tool result surfaces `plan_bind: { path, node_id, requested_node_id?, hint? }`.

Expert Graph docs/prompts require `plan_node_id` for formal packages (L2 ownership). Free path without Hard Graph plan store: chip path returns `{ path: "none" }` (no Tasks L2 mutation from host).

### 3.3 Multi-package / reattach behavior

- Same agent, same or missing new `plan_node_id`: typically **`reattach`** → **one** L2 row keeps the Worker chip; status flips running→done/failed.
- Explicit **new** `plan_node_id`: `attachWorker` binds the new node. Code does **not** clear the previous row’s `agent_id` / `owner_agent_name`. Possible residual: **two L2 rows** still showing the same Worker chip after a re-anchor (reattach later finds **first** matching agent id).
- Todo snapshot merge (`setStageTodos`) **preserves** prior ownership when rewrite omits `agent_id`.

### 3.4 UI chip presentation

`humanAgentChipName(owner_agent_name)` (`platform/frontend/src/lib/workerPresentation.ts`):

- Prefer clean `Worker N`.
- Also allows other short non-opaque names (would show a custom rename **if** ever stored).
- Rejects raw `sub_*` / handoff strings.

---

## 4. Multi-package on one id — one roster row vs multiple

| Layer | Same warm id | Distinct cold ids |
|-------|--------------|-------------------|
| `PanelAgentTracker.children` | **One** Map entry; start overwrites goal; end overwrites status | Multiple entries / Worker N, N+1, … |
| Case `merge_panel_agents` (backend) | Upsert by id; same id overwrites | Multiple children kept |
| FE `mergeLivePanelAgents` | Upsert by normalized id under role root | Multiple children |
| Tasks L2 | Prefer reattach to one owned row; explicit re-bind can leave dual chips | Separate binds / pkg rows |
| Disk `subagents/{id}/` | Shared; latest settlement/result for package files | Separate directories |

**Product roster answer:** multi-package on one id already yields **one collaboration-tree row** with updated `task`/status, not one row per package attempt.

---

## 5. Case persistence, FE merge, and streams

### 5.1 Case participants

`platform/backend/app/services/case_participants.py` · `merge_panel_agents`:

- Children **append/upsert by id**; never dropped because a later burst is main-only.
- Same id across bursts **overwrites** the prior row.
- Orphans still marked running when absent from incoming → settled to `completed`.
- Documented: no prune / no task_id bucketing yet.

### 5.2 Live FE merge

`platform/frontend/src/lib/panelAgentsState.ts` · `mergeLivePanelAgents` / `mergePanelChildren`:

- Role root from `expert_id` / name / highlight.
- Child ids normalized to `` `${rootId}-${child.id}` `` when not already prefixed.
- Prior kids missing from this burst **kept** (history).
- Terminal settle is **backend** responsibility.

### 5.3 Display helpers

`agentDisplayName` trusts Node’s `Worker N`; **does not invent ordinals**. Comment: “Node PanelAgentTracker is the sole sequencer.” `legacyWorkerDisplayName` only reuses an already-known clean name.

### 5.4 Worker process stream into Case chat — deliberately absent

`attachProductToolEventBridge` (`run-node4-agent.ts`): when `lifecycle.subagentDepth > 0` (package workers set `subagentDepth: 1`), **skip** platform `tool_output` so Worker tools do not pollute Main chat. Lifecycle milestones remain parent-owned (`subagent_started` / `subagent_finished`).

Parent gets structured package outcomes via `injectParentObservationsFromChild` (proof grounding), not a Main-like thinking/tool timeline for the Worker.

---

## 6. Gaps vs charting locks (Case rename + stacked Packages dialog)

Charting locks from map **#253** (identity + rename + continuous thread) vs code:

| Charting lock | Code fact | Gap |
|---------------|-----------|-----|
| One tree node = one Worker conversation thread | One tree node **per id**; warm multi-package updates that node | Thread is a **roster lifecycle**, not a stored multi-package transcript |
| Multiple Packages stack in the **same** dialog | No Worker audit dialog UI; RightPanel collaboration is tree/status only | Dialog + package-turn markers **unspecified/unimplemented** |
| Case-persistent display rename; default `Worker N` | Names always `formatWorkerName(N)` from Node; no rename API, no Case field for alias | Rename storage + write-path + FE edit surface missing |
| Same label on tree, dialog, Tasks | Tree + Tasks both derive from `Worker N` / `owner_agent_name` today | If rename is added, must update `panel_agents.name` **and** L2 `owner_agent_name` (and survive `merge_panel_agents` / todo rewrites) |
| Live + Case replay of Worker process | Package tool/thinking **not** sent to Case; warm pi session has in-process history only while parked; task end `disposeAll` | No durable Worker-scoped stream for Case reload |
| Identity ≠ routing change on rename | N/A today (no rename) | Spec should keep `id` / `agent_id` as routing keys |

### 6.1 Concrete holes for Spec #253 implementation research

1. **No Worker-scoped event bus** tagged for dialog (tool_output suppressed; no `subagent_id` on Main thinking/tool stream).
2. **panel_agents** holds **latest** task/detail only — not a package stack.
3. **Evidence / result.json** are package-terminal artifacts; warm path clears intentional structured files before the next package; not a turn timeline UI model.
4. **Rename** has no source of truth; FE `humanAgentChipName` would accept non-`Worker N` strings if written, but nothing writes them.
5. **Dual L2 chip residual** if same agent is explicitly re-anchored to a new `plan_node_id` without clearing the old row.
6. **Ordinal reset** on new task/tracker vs Case-long history of prior `sub_*` ids from earlier bursts (merge keeps rows; new run assigns Worker N from a fresh seq — historical names stay as last written).

---

## 7. Symbol / path index

| Concern | Path / symbol |
|---------|----------------|
| Tracker + Worker N | `node4/src/runtime/panel-agents.ts` — `PanelAgentTracker`, `workerIndexFor`, `formatWorkerName`, `noteSubagentStart/End` |
| Host spawn + panel emit + chip | `node4/src/runtime/subagent.ts` — `SubagentHost.spawn`, `upsertHardGraphPackageChip`, `emitPanelAgentsSnapshot` |
| Package tool + resume | `node4/src/tools/subagent.ts` — `runSubagentPackage`, `resume_agent_id`, `session_reuse` |
| Idle pool | `node4/src/runtime/subagent-idle-pool.ts` — `SubagentIdlePool`, `tryResume`, `park`, `checkAffinity` |
| Warm/cold LLM session | `node4/src/runtime/subagent-session.ts` — `runWarmPackage`, `runColdPackage` |
| Tasks bind | `node4/src/runtime/hard-graph-plan.ts` — `resolveWorkerBind`, `applyChip`, `reattachWorkerByAgent` |
| Graph panel share | `node4/src/runtime/hard-graph-task.ts`, `hard-graph-stage-executor.ts` |
| Free panel + dispose pool | `node4/src/runtime/session-runner.ts` |
| Suppress Worker tool chat | `node4/src/runtime/run-node4-agent.ts` — `attachProductToolEventBridge`, `isSubagentPackageSession` |
| Case merge | `platform/backend/app/services/case_participants.py` — `merge_panel_agents` |
| Live merge | `platform/frontend/src/lib/panelAgentsState.ts` — `mergeLivePanelAgents` |
| Chip / name FE | `platform/frontend/src/lib/workerPresentation.ts`, `components/TasksPlanList.tsx` |
| Spec surface language | `docs/specs/task-graph.md` (panel_agents, Worker chips) |

---

## 8. Non-goals of this ticket

- Implementing Worker dialog, rename, or stream persistence.
- Changing idle-pool policy or bind priority.
- Resolving multi-expert rename ownership (map “Not yet specified”).
