# Research: Subagent stream and Case persistence path today

**Ticket:** [#254](https://github.com/zangjiaao/my-ai-pen/issues/254)  
**Map:** [#253 Wayfinder: Worker process audit (collaboration dialog Spec)](https://github.com/zangjiaao/my-ai-pen/issues/253)  
**Scope:** Facts from Node4, platform backend, platform frontend, living docs. No product recommendations as decisions.  
**Date:** 2026-07-30

---

## Question

What exists today for **Worker/subagent observability** from Node4 → platform → conversation UI, and what is missing for **live + Case replay** of a Worker transcript?

---

## 1. Node4: events emitted for subagents

### 1.1 Lifecycle events (parent-owned)

`SubagentHost.spawn` in `node4/src/runtime/subagent.ts` emits two platform messages around the worker:

| Event | Fields | When |
|-------|--------|------|
| `subagent_started` | `conversation_id`, `task_id`, `subagent_id`, `goal_id`, `assignment` (label/assignment slice ≤500), `panel_agents` | After `noteSubagentStart` + panel snapshot + optional Hard Graph chip upsert |
| `subagent_finished` | same ids + `ok`, `evidence_id`, `summary` (≤500), `panel_agents` | After `result.json` write, evidence create, `noteSubagentEnd`, panel snapshot, chip settle |

Symbols: `SubagentHost.spawn` (`subagent_started` ~L218–227, `subagent_finished` ~L278–288).

**Stable id:**

- Cold spawn: `subagentId = options.subagentId?.trim() || \`sub_${Date.now()}_${++subSeq}\`` (`subagent.ts` ~L186).
- Warm resume: tool layer passes existing `warmHandle.agentId` as `subagentId` (`node4/src/tools/subagent.ts` ~L536–537) so keep-alive reuses the same id.
- Panel `PanelAgentRecord.id` is that same string (`panel-agents.ts` `noteSubagentStart`).
- Hard Graph Tasks chips stamp `agent_id: input.subagentId` and `owner_agent_name: formatWorkerName(N)` (`subagent.ts` `upsertHardGraphPackageChip` ~L120–136).

There is **no** separate product event for mid-package status beyond panel updates (below). There is **no** `subagent_thinking` / `subagent_tool_call` / Worker-scoped `text` type.

### 1.2 Panel / checkpoint (collaboration tree only)

On start and end, `emitPanelAgentsSnapshot` also sends:

1. `status_update` with `message: "panel_agents"`, `agent_phase: "subagent"`, `panel_agents: list()`
2. `checkpoint_update` with `checkpoint: { runtime: "node4-pi", panel_agents, agent_phase: "subagent", task_id }`

(`subagent.ts` `emitPanelAgentsSnapshot` ~L63–94.)

`PanelAgentTracker` (`node4/src/runtime/panel-agents.ts`) shapes each Worker row as:

- `id`, `name` (`Worker N` via stable `workerIndexById`), `status`, `parent_id: "node4-main"`, `task` (goal), `role: "subagent"`, `current_action`, `current_detail`, optional `goal_id` / `error` / `outcome`.

Main’s free path and Hard Graph stages share this tracker:

- Free: `session-runner.ts` constructs `PanelAgentTracker` and passes it into `SubagentHost`.
- Hard Graph: `hard-graph-stage-executor.ts` shares `graphRun.panel` / `panelAgents` with stage child and `SubagentHost` (~L272–310, ~L682–692).

Main tool phases also push `panel_agents` on `status_update` + full `checkpoint_update` via `handleNode4SessionEvent` (`platform-observability.ts`).

### 1.3 Worker process stream (thinking / text / tools) — not on platform sink today

**Policy A (explicit):** package sessions must not emit `tool_output` into Case chat.

```259:326:node4/src/runtime/run-node4-agent.ts
 * Product policy (A): **subagent package sessions do not emit tool_output into Case chat.**
 * When `lifecycle.subagentDepth > 0`, still count tools for salvage/settlement, but skip
 * platform send so Worker shell/http/todo cards do not pollute Main's conversation thread.
 * Lifecycle milestones (`subagent_started` / `subagent_finished`) remain parent-owned.
...
export function isSubagentPackageSession(runtime: ToolRuntime): boolean {
  const depth = Number(runtime.lifecycle?.subagentDepth ?? 0);
  if (depth > 0) return true;
  const tid = String(runtime.task?.taskId || "");
  return /\/sub\//.test(tid);
}
```

Test: `run-node4-agent.test.ts` `testToolEventBridgeSilentForSubagentDepth` asserts zero `tool_output` when `subagentDepth: 1`.

**Child LLM session construction** (`node4/src/runtime/subagent-session.ts`):

- Sets `lifecycle.subagentDepth: 1` and `taskId: \`${parent.task.taskId}/sub/${subagentId}\`` (~L528–567).
- Uses `createBoundNode4Session` only → attaches `attachProductToolEventBridge` (silent for tools).
- Does **not** call `attachNode4SessionObservability` / `PlatformTextStream`.

**Main free path and Hard Graph stage sessions** do attach observability:

| Path | File | Streams |
|------|------|---------|
| Free OMP Main | `session-runner.ts` | `PlatformTextStream` + `attachNode4SessionObservability` |
| Hard Graph stage Main | `hard-graph-stage-executor.ts` ~L699–735 | same |
| Package Worker | `subagent-session.ts` | neither |

`PlatformTextStream` / `ProgressiveContentStream` (`platform-observability.ts`) emit only:

- type `text` or `thinking`
- content `{ text, stream_id }` or `{ text, reasoning, stream_id }`
- top-level `conversation_id`, `task_id`, `stream_id`

**No `agent_id` / `subagent_id` field** is attached to progressive frames (`platform-observability.ts` flush ~L178–192). `stream_id` is `n4-{channel}-{task.taskId}-{sequence}` — for Main that is the parent task id; Workers never open this path today.

Documented product contracts:

- `docs/specs/task-graph.md` § Expert Graph workbench observability: Main stage gets thinking/text; subagent lifecycle is listed as started/finished + panel + chips — not Worker token streams.
- `docs/specs/harness.md` § Platform events: `text`, `tool_output`, … for the harness/Main surface; no Worker-scoped variants.

### 1.4 Local Node workspace artifacts (not Case message store)

Parent task dir (`session-runner.ts`):

- `events.jsonl` — wrapper platform sink logs outbound messages (including `subagent_started` / `subagent_finished` / checkpoints) before WS send.
- `transcript.jsonl` + `session-manifest.json` — written by `writePostRunInspectArtifacts` for **Main** only (`session-runner.ts` end-of-task; not called from `subagent-session.ts`).

Per Worker (`SubagentHost` + `ensureChildDirs`):

- `taskDir/subagents/<subagentId>/assignment.md`
- `result.json` (host wrapper payload)
- optional `settlement.json` (child intentional structured settlement)
- dirs: `facts/`, `evidence/`, `findings/`, `scripts/`, `tool-output/`, `pi-sessions/`

These are Node workspace inspect paths (`CONTEXT.md` Runtime transcript vs Product state; `session-inspect.ts`). They are **not** loaded by platform Case replay APIs.

---

## 2. Platform: persistence and broadcast

### 2.1 Hot path (`platform/backend/app/ws/router.py`)

On Node → platform WS messages (~L841–873):

| Kind | Broadcast | Persist |
|------|-----------|---------|
| `text`, `thinking`, `agent_thinking`, `reasoning`, `tool_output` | Immediate (`stream_fast`) | Async `_save_message` (non-blocking) |
| Other savable types (incl. `subagent_started` / `subagent_finished` if not excluded) | After optional save | Sync `_save_message` when `should_save` |
| `checkpoint_update` | After save gate (not excluded from broadcast except work_status/intake) | **Not** `_save_message`; goes to `_remember_conversation_checkpoint` |
| `intake_update`, `work_status` | Not broadcast as chat | Not saved as messages |

`should_save` excludes only `intake_update`, `work_status`, `checkpoint_update`, pentest harness status ticks, and rejected engagement_closeout.

So **`subagent_started` / `subagent_finished` are eligible for message persistence** (not in the exclude set). `_save_message` unknown types fall into `else: content = dict(msg)` with original `msg_type` (~L1898–1899). They are **not** mapped to a first-class UI `msg_type` like `tool_call` / `thinking`.

### 2.2 Stream message identity

`_stamp_stream_message_ids` (~L1695–1733):

- `text` + `stream_id` → uuid5 `text:{conv_id}:{stream_id}`
- `thinking`/`agent_thinking`/`reasoning` + `stream_id` → uuid5 `thinking:{conv_id}:{stream_id}`
- `tool_output` + `tool_run_id` → uuid5 `tool:{conv_id}:{tool_run_id}`

**No branch keys on `agent_id` / `subagent_id`.** Dedup/merge for text/thinking is by stream_id within the conversation only.

### 2.3 Message row schema

`platform/backend/app/models/message.py`: `id`, `conversation_id`, `role`, `msg_type`, `content` (JSONB), `parent_msg_id`, `created_at`.

No column for agent/subagent identity. Any attribution would have to live inside `content` JSON — Node Main streams do not put Worker ids there today.

Agent attribution used for multi-seat chat is `agent_source` / `agent_node_id` / expert stamps (`_save_message` agent branch ~L1901+), which identify **product expert / Node client**, not package Worker ids.

### 2.4 Case roster persistence (`panel_agents`)

Checkpoints update Case participants via `case_participants` (`platform/backend/app/services/case_participants.py`):

- `merge_panel_agents`: upsert children by id; **keep** prior Workers not in the new burst; settle orphan “running” children to `completed` when a later main-only panel arrives.
- Stored under `conversation.context.participants[<role>].panel_agents`.

Snapshot projection: `strix_agents_from_checkpoint` in `conversation_snapshot.py` reads `checkpoint.panel_agents` (or legacy `node3_strix.agents`).

**What is Case-replayable for Workers today:** collaboration tree metadata (id, name `Worker N`, status, task/goal, current_detail, role).  
**What is not:** progressive thinking/tool/text process frames for that Worker.

### 2.5 Main chat transcript vs Worker transcript

Persisted Case timeline (messages table) is effectively the **Main narrative stream**:

- Main `text` / `thinking` / `tool_call` (from Main `tool_output`)
- Cards, status rows, confirm, vulns, etc.
- Optionally raw rows for `subagent_started` / `subagent_finished` if saved (msg_type kept as those strings)

Frontend `isRenderableMessage` (`ConversationPage.tsx` ~L3313–3317) **does not include** `subagent_started` / `subagent_finished`, so even if those rows exist in DB, they do **not** appear as Main chat bubbles. Live handlers only update `strixAgents` panel state.

---

## 3. Frontend: stream attach and agent filtering

### 3.1 Live stream overlay

`ConversationPage.tsx`:

- `liveStreams` state: progressive bubbles keyed by `stream_id` or `message_id` (~L274–279).
- Handlers `thinking` / `agent_thinking` / `reasoning` / text path → `upsertStreamedAgentText` (~L1379–1442).
- Merge into `displayMessages` by `stream:{stream_id}` without agent scoping (~L333–386).
- Tool cards: `tool_output` → `tool_call` messages; merge by `tool_run_id` / agent_source / agent_node_id (expert/node), not subagent id.

**There is no filter-by-agent-id for live streams.** All progressive frames for the conversation land in the single Main timeline.

### 3.2 Subagent lifecycle handlers

```912:986:platform/frontend/src/pages/ConversationPage.tsx
    subagent_started: (msg) => {
      // mergeLivePanelAgents or upsertSubagentChild from panel_agents / subagent_id
    },
    subagent_finished: (msg) => {
      // same → status completed|failed
    },
```

Also: `checkpoint_update` merges `panel_agents` / `node3_strix.agents` via `mergeLivePanelAgents` (~L1035–1053). Legacy Node2 `worker_started` / `worker_finished` still present (~L1103+).

### 3.3 Collaboration tree UI

`AgentCollaborationTree.tsx` / `StrixAgentList`:

- Renders Main roots + Worker children; expand/collapse only.
- **No onClick open dialog**, no transcript fetch, no per-agent message filter.
- Display helpers: `workerPresentation.ts` (`agentDisplayName`, scrub package markdown, prefer role `subagent`).
- Frontend remaps child ids under role root: `` `${rootId}-${child.id}` `` (`panelAgentsState.ts` `upsertSubagentChild` / `mergeLivePanelAgents`) for multi-expert Case trees. Underlying Node id remains `sub_…` inside panel payloads before remapping.

### 3.4 Case reload path

On load / snapshot refresh:

- Messages infinite query → Main timeline only (renderable types).
- `strixAgents` from Case participants / checkpoint `panel_agents` (backend merge is SoT for historical Workers across bursts — comment at ConversationPage ~L588).
- Live overlay empty after refresh until new WS frames.

### 3.5 Rename

No Case-persistent Worker display-name field found in platform models or frontend. Names are Node-side `Worker N` from `formatWorkerName` (`panel-agents.ts`). Expert `display_name` is product expert persona, unrelated to Worker rename.

---

## 4. End-to-end path (as-built)

```
Main session (free or Hard Graph stage)
  ├─ attachNode4SessionObservability + PlatformTextStream
  │     → text / thinking / status_update / checkpoint_update
  │     → platform stream_fast → Case messages + live overlay (Main)
  ├─ attachProductToolEventBridge
  │     → tool_output → tool_call cards (Main only)
  └─ SubagentHost.spawn
        ├─ subagent_started + panel_agents (+ checkpoint)
        │     → platform save (msg_type raw) + broadcast
        │     → UI: panel tree only (not Main bubble)
        ├─ runSubagentLlmSession (depth=1)
        │     ├─ createBoundNode4Session → tool bridge SILENT
        │     ├─ NO text/thinking stream attach
        │     └─ local workDir artifacts only
        └─ subagent_finished + panel_agents (+ checkpoint)
              → panel tree settle; evidence on Node + optional platform evidence row
```

---

## 5. Gaps vs map #253 charting locks

Map locks (from issue #253 body): **Live + Case replay**; **Worker dialog** (Package turns + thinking + tools + text); **Main narrative stays Main**; **dialog-only Worker detail**; every Worker on tree; Case rename.

| Map expectation | Today (fact) |
|-----------------|--------------|
| Live Worker transcript (thinking + tools + text) | **Missing.** Workers do not emit those frames; bridge intentionally suppresses `tool_output`; no text/thinking attach. |
| Case-replay Worker transcript | **Missing.** Messages store is Main-oriented; no agent-scoped stream frames; local `subagents/<id>/` is Node disk, not Case API. |
| Package-turn markers in a Worker thread | **Partial metadata only.** `subagent_started`/`finished` + assignment label + panel task; no structured multi-Package timeline UI; warm resume reuses same `subagent_id` (identity continuous) but no stacked Package-turn message model in Case. |
| Dialog-only Worker detail | **No dialog.** Tree is display-only; Main chat intentionally not polluted by Worker tools (Policy A). |
| Filter stream by agent/subagent id | **No.** Streams lack tags; UI does not filter. |
| Stable Worker identity for tree/Tasks | **Present.** `sub_*` / resume `agent_id`; `Worker N` name; Hard Graph `agent_id` / `owner_agent_name` chips; Case `merge_panel_agents` keeps history across bursts. |
| Case-persistent rename | **Absent.** |
| Main light lifecycle hints | **Thin.** Panel status + Tasks chips; lifecycle events not renderable in chat; Main may still show its own `subagent` **tool_call** card (parent tool bridge) depending on tool args/summary, which is Main narrative, not full Worker process. |

---

## 6. Symbol index (primary sources)

| Layer | Path | Symbols / notes |
|-------|------|-----------------|
| Node lifecycle | `node4/src/runtime/subagent.ts` | `SubagentHost.spawn`, `emitPanelAgentsSnapshot`, `upsertHardGraphPackageChip` |
| Panel roster | `node4/src/runtime/panel-agents.ts` | `PanelAgentTracker`, `formatWorkerName`, `noteSubagentStart/End` |
| Silent tools | `node4/src/runtime/run-node4-agent.ts` | `attachProductToolEventBridge`, `isSubagentPackageSession` |
| Child session | `node4/src/runtime/subagent-session.ts` | `runSubagentLlmSession`, `subagentDepth: 1`, no observability attach |
| Main streams | `node4/src/runtime/platform-observability.ts` | `PlatformTextStream`, `handleNode4SessionEvent`, `buildNode4Checkpoint` |
| Free attach | `node4/src/runtime/session-runner.ts` | logging platform, `SubagentHost`, post-run inspect |
| Graph attach | `node4/src/runtime/hard-graph-stage-executor.ts` | shared panel + stage observability |
| Tool entry | `node4/src/tools/subagent.ts` | packages, warm resume `agent_id` |
| Platform WS | `platform/backend/app/ws/router.py` | stream_fast, `_save_message`, `_stamp_stream_message_ids` |
| Case panel merge | `platform/backend/app/services/case_participants.py` | `merge_panel_agents`, `upsert_participant` |
| Snapshot | `platform/backend/app/services/conversation_snapshot.py` | `strix_agents_from_checkpoint` |
| Message model | `platform/backend/app/models/message.py` | no agent_id column |
| Live UI | `platform/frontend/src/pages/ConversationPage.tsx` | `liveStreams`, subagent handlers, `isRenderableMessage` |
| Panel merge UI | `platform/frontend/src/lib/panelAgentsState.ts` | `mergeLivePanelAgents`, `upsertSubagentChild` |
| Tree UI | `platform/frontend/src/components/AgentCollaborationTree.tsx` | display only |
| Specs | `docs/specs/harness.md`, `docs/specs/task-graph.md`, `docs/prd.md` | event contracts / panel_agents |
| Domain | `CONTEXT.md` | Package, Wave, Runtime transcript vs Product state |

---

## 7. One-line gist (for map #253)

**Today: Worker lifecycle + panel_agents are Case-visible; Worker thinking/tool/text streams are intentionally not emitted or Case-persisted — only Main’s stream is live/replayable; no agent-id stream filter or Worker dialog.**
