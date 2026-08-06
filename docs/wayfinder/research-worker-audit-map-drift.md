# Research: Codebase drift vs Worker audit map (revalidate #254 / #255)

**Ticket:** [#306](https://github.com/zangjiaao/my-ai-pen/issues/306)  
**Map:** [#253 Wayfinder: Worker process audit (collaboration dialog Spec)](https://github.com/zangjiaao/my-ai-pen/issues/253)  
**Scope:** Facts only — re-check prior research gists and charting locks against **current product code**. No product Spec decisions, no feature implementation.  
**Date:** 2026-08-06

---

## 1. Scope / method / tree identity

### Question

Do map **#253** charting locks, closed research **#254** / **#255**, and open tickets **#256–#260** still match **today’s codebase**, or are there conflicts / superseded facts?

### Method

1. Read map body (#253) and closed resolution comments (#254, #255).
2. Read prior research docs from throwaway branches (not on `main`):
   - `origin/research/subagent-stream-case-persistence` → `docs/wayfinder/research-subagent-stream-case-persistence.md` (commit `53fde3a`, 2026-07-30)
   - `origin/research/worker-identity-continuity` → `docs/wayfinder/research-worker-identity-continuity.md` (commit `485a579`, 2026-07-30)
3. Treat those docs as **hypotheses**. Re-walk primary sources on the product tree (Node4 + platform FE/BE + living `docs/specs/*`).
4. Note adjacent Specs landed after research dates: **#276** stream identity, **#301** Worker sort/bind, **#302** subagent limits/keep-alive; WIP **#305** timeline liveness (not on `main` at validation time).

### Trees used

| Ref | SHA (short) | Role |
|-----|-------------|------|
| `origin/main` | `c940d8f` | **Primary truth** for this revalidation (branch base) |
| Prior research #254 | `53fde3a` | Hypotheses only |
| Prior research #255 | `485a579` | Hypotheses only |
| WIP (not merged) | `feat/timeline-activity-liveness-305` (local, stashed during write) | **Note only:** Spec #305 thinking `status` / empty running / pending speaker — Main progressive path; does **not** attach Worker streams or agent-id tags |

Product work of interest on/after research dates and present on `origin/main`:

- PR path for Spec **#301** (numeric Worker sort + host auto-bind Free/Graph) — merged (`0143af1` lineage).
- Spec **#302** subagent concurrency / task budget / keep-alive docs + code — merged (`c940d8f`).
- Spec **#276** `docs/specs/stream-message-identity.md` — implemented (frontend progressive identity).

---

## 2. Prior #254 claims → current status

Prior gist (map Decisions / resolution): *Worker lifecycle + `panel_agents` Case-visible; thinking/tool/text not emitted or Case-persisted for Workers (Main-only stream); no agent-id filter or Worker dialog.*

| # | Prior claim (#254) | Status | Evidence on `origin/main` (`c940d8f`) |
|---|-------------------|--------|----------------------------------------|
| 1 | Parent-owned lifecycle only: `subagent_started` / `subagent_finished` + `panel_agents` on start/end snapshots | **Still true** | `node4/src/runtime/subagent.ts` — `emitPanelAgentsSnapshot`, `type: "subagent_started"` (~L319), `type: "subagent_finished"` (~L379); `noteSubagentStart` / end around spawn |
| 2 | Policy A: package sessions (`subagentDepth ≥ 1` or `taskId` with `/sub/`) do **not** emit `tool_output` into Case chat | **Still true** | `node4/src/runtime/run-node4-agent.ts` L275–347 — comment Policy A; `isSubagentPackageSession` early-return before `platform.send` for tool start/end |
| 3 | `runSubagentLlmSession` uses `createBoundNode4Session` only — **no** `attachNode4SessionObservability` / `PlatformTextStream` | **Still true** | `node4/src/runtime/subagent-session.ts` — cold path `subagentDepth: 1` (~L582), `createBoundNode4Session` only (~L598); no observability import/call. Contrast Free Main `session-runner.ts` and Hard Graph `hard-graph-stage-executor.ts` which attach observability |
| 4 | Progressive `text`/`thinking` frames carry `stream_id` + task ids only — **no** `agent_id` / `subagent_id` | **Still true** | `node4/src/runtime/platform-observability.ts` progressive flush content `{ text, stream_id }` / thinking `{ text, reasoning, stream_id }` (~L181–191 on main); no `agent_id` symbol in that file. `stream_id` = `n4-{channel}-{task.taskId}-{seq}` |
| 5 | Case message model is Main-oriented; no agent column; `panel_agents` survives via Case participants merge | **Still true** | `platform/backend/app/models/message.py` — columns: `id`, `conversation_id`, `role`, `msg_type`, `content` JSONB, `parent_msg_id`, `created_at` (no agent_id). `case_participants.merge_panel_agents` still upsert-by-id, keep orphans, settle running orphans |
| 6 | FE live overlay conversation-wide (no filter-by-agent); `subagent_*` update tree only; lifecycle not renderable in chat; tree has no Worker dialog / click-through | **Still true** | `ConversationPage.tsx` — `liveStreams` by stream_id; `subagent_started`/`finished` handlers (~L864+); `isRenderableMessage` (~L3379) omits `subagent_started`/`finished`. `AgentCollaborationTree.tsx` — Worker row `onClick` is expand/collapse only when children exist (`onToggle`); no dialog open |
| 7 | No Case Worker rename field/API | **Still true** | No Worker display-name write path in platform models/services; names remain Node `formatWorkerName` / `Worker N` via panel payload |
| 8 | Gap vs map locks (Live+Case Worker transcript + dialog): identity/tree metadata exist; continuous Worker transcript does not | **Still true** | Same structural gap; adjacent Specs improve Main timeline identity (#276) and Tasks/roster sort/bind (#301), not Worker process wire |

### #254 claims that are **partial** (context updated, gap unchanged)

| # | Claim nuance | Status | What changed |
|---|--------------|--------|--------------|
| P1 | “Main streams untagged” | **Still true for agent/subagent** | Spec **#276** keys Main progressive UI by `stream_id` only and retires live-slot-as-Message. That is **conversation Main timeline** identity, not Worker-scoped identity. Still no `subagent_id` on frames. |
| P2 | “Frontend remaps child ids under role root” | **Still true** (not re-opened as conflict) | Presentation/merge helpers still normalize multi-expert trees; not a new dialog surface |

### #254 claims that are **false** today

**None found.** Core stream/persistence gap statements remain accurate on `origin/main`.

---

## 3. Prior #255 claims → current status

Prior gist: *Same id = one tree row + stable Worker N on resume; Tasks reattach via agent_id; no Case rename; no stacked Package dialog/stream.*

| # | Prior claim (#255) | Status | Evidence on `origin/main` |
|---|-------------------|--------|---------------------------|
| 1 | Stable `Worker N` via `PanelAgentTracker.workerIndexById`; resume keeps N | **Still true** | `node4/src/runtime/panel-agents.ts` (ordinal map + `formatWorkerName`); FE trusts clean `Worker N` (`workerPresentation.ts` / tree ordinal parse) |
| 2 | Roster is Map-by-id: multi-package on same id → **one** tree row (task/status overwrite), not one row per package | **Still true** | Tracker `children.set(id, …)` overwrite; Case `merge_panel_agents` same-id overwrite; FE live merge upsert by id |
| 3 | Idle pool: same id only when Main passes `resume_agent_id` + same-path affinity; cold = new `sub_*`; in-memory TTL / maxPackages / disposeAll | **Still true** (refined docs/limits) | `subagent-idle-pool.ts` — TTL / maxIdle / maxPackages; `task-graph.md` § parallel subagent batch documents keep-alive + release; Spec **#302** adds concurrency scheduler + **task package budget** (default 128) — does **not** invent auto path-grab or Case-persisted idle pool |
| 4 | Tasks bind order: explicit `plan_node_id` → reattach → single_free → fuzzy → `pkg-*`; dual-chip residual possible on explicit re-anchor | **Still true** for Graph; **expanded** for Free | Hard Graph `resolveWorkerBind` unchanged priority. Spec **#301**: Free Main Todo host path `SubagentHost.upsertFreeTodoChip` / `TodoStore.resolveWorkerBind` — same priority family on Free todos. Dual L2 residual still possible if old row not cleared |
| 5 | No Case display-rename field/API | **Still true** | Unchanged |
| 6 | Package tool streams suppressed; no Worker audit dialog; no durable multi-package Worker transcript for Case replay | **Still true** | Policy A + no dialog UI (see §2) |
| 7 | Identity continuity exists; continuous conversation product surface does not | **Still true** | Unchanged product gap |

### #255 claims that are **partial** (identity side improved)

| # | Claim nuance | Status | What changed |
|---|--------------|--------|--------------|
| P1 | “Free path without Hard Graph plan store: chip path returns none” (as of #255) | **Partial / outdated detail** | Spec **#301** lands Free host auto-bind + Tasks chip stamping on Main todos. **Does not** create stacked Package dialog or rename |
| P2 | Worker list order | **Partial update** | Spec **#301**: numeric sort `compareAgentNames` / `orderStrixAgents` (1,2,10,11 not lex 1,10,11,2). Presentation only |

### #255 claims that are **false** today

**None for the map-relevant gists** (rename gap, one-row-per-id, no stacked dialog). The Free-path “no chip bind” **detail** in older research is **stale**; replace with “Free host bind exists (#301)” without treating the identity/dialog gists as obsolete.

---

## 4. Map charting locks → code status

Locks from #253 body (do not re-open without rewriting Destination). Status = code vs lock, not product recommendation.

| Charting lock | Code status | Notes |
|---------------|-------------|-------|
| **D-spec** — end state = one implementable Spec (not shipping UI on this map) | **Unrelated to code drift** | Process lock; still no Worker-audit Spec under `docs/specs/` |
| **Time window** — Live + Case replay | **Gap remains** | No Worker thinking/tool/text on wire; no Case-persisted Worker process frames. Main progressive path improved (#276) but is Main-only |
| **Worker scope** — every Worker row (Graph packages **and** free/`subagent` path) | **Gap remains** (identity present for both) | Free + Graph both use `SubagentHost` + panel tracker; Free now has Tasks bind (#301). Still no per-Worker transcript for either path |
| **Content V1** — Package-turn markers + thinking + tool_call (+ text) | **Gap remains** | Lifecycle assignment/summary only; Policy A silences tools; no text/thinking attach on package sessions |
| **Main vs dialog** — Main narrative stays Main; Worker process detail dialog-only | **Partial progress on Main side only** | Policy A still protects Main from Worker tool cards (aligns with “don’t dump Worker process into Main”). **Dialog does not exist**, so Worker detail has nowhere to go except panel status / Tasks chips / parent `subagent` tool_call (Main narrative) |
| **Worker identity** — one tree node = one Worker conversation thread; multi-Package stacks in same dialog | **Partial progress** | One tree node per id + warm resume + keep-alive **still true** (supports “same thread identity”). Stacked multi-Package **dialog/transcript** **gap remains**. `panel_agents` holds **latest** task/detail only |
| **Rename** — Case-persistent display name; default `Worker N`; tree/dialog/Tasks unified; does not change agent id | **Gap remains** | No Case rename SoT/API/UI. Tasks/tree share default `Worker N` / `owner_agent_name` today only |
| **Interaction V1** — read-only audit + rename; no in-dialog steer | **Gap remains** (unimplemented surface) | No dialog chrome; rename absent. Nothing in code **contradicts** read-only V1 |

**Contradicts lock?** **No product code found that implements an alternate Worker-audit design that would force rewriting Destination.** Spec #276/#301/#302 do not replace the map destination with a different shipped audit UX.

---

## 5. Open tickets #256–#260 impact

| Ticket | Kind | Impact |
|--------|------|--------|
| [#256](https://github.com/zangjiaao/my-ai-pen/issues/256) Grilling: Package-turn / process / delivery timeline | grilling | **Proceed** — process stream still missing; timeline contract still unspecified. No rewrite forced by code |
| [#257](https://github.com/zangjiaao/my-ai-pen/issues/257) Grilling: Worker display-name model | grilling | **Proceed** — rename still absent. Optional **question refresh** (not invalidate): note Spec #301 Free bind + numeric sort as existing default-label surfaces Tasks/tree already share |
| [#258](https://github.com/zangjiaao/my-ai-pen/issues/258) Grilling: Live fidelity + Main lifecycle-hint bounds | grilling | **Proceed**; **question refresh recommended** — Main progressive identity is now Spec **#276** (stream_id SOT, pending chrome). WIP **#305** (if merged later) further defines Main thinking liveness. Still **no** Worker live frames. Grill should distinguish Main-fidelity Specs from Worker-dialog fidelity |
| [#259](https://github.com/zangjiaao/my-ai-pen/issues/259) Prototype: dialog skeleton | prototype | **Proceed** — tree still has no open path beyond expand/collapse; prototype still useful before Spec chrome freeze |
| [#260](https://github.com/zangjiaao/my-ai-pen/issues/260) Task: Author implementable Spec | task | **Proceed after grilling** — destination still valid. Author should cite current facts: Policy A, no Worker observability attach, #276 Main stream_id model, #301 Free bind + sort, #302 keep-alive/budgets — without treating #254/#255 gists as obsolete |

**Supersede any open ticket?** **No.** None of #256–#260 are fully implemented or invalidated by shipped code.

**Map Decisions gists for #254/#255:** **Not stale on the gap** (stream/dialog/rename still absent). Optional Notes polish only: Free Tasks bind and numeric sort landed (#301); Main stream identity Spec #276 landed; #302 documents keep-alive/budgets. **Do not** rewrite Destination or charting locks from this research alone.

---

## 6. New fog / out-of-scope candidates (facts only)

Observations that were thinner or absent in July research; **not** Spec decisions:

1. **Main progressive contract matured (#276 on `main`):** live map + RQ keyed by `stream_id`; fail-closed without `stream_id`; pending is non-Message chrome. Any future Worker progressive path would either reuse this identity model or invent a parallel one — today Workers never open the path.
2. **WIP #305 (not on `main` at write):** thinking `content.status` running/done, empty running frames, pending speaker reuse — still **Main session observability** only if/when merged. Does not fill Worker attach gap.
3. **Spec #302 task budget / batch ceiling / concurrency:** may change how often multi-package warm stacks occur in practice; idle affinity rules unchanged (explicit `resume_agent_id` + same path).
4. **`stream_id` embeds `task.taskId`:** Worker child task ids are `{parent}/sub/{subagentId}` when a child session exists. If observability were ever attached to package sessions, stream ids would naturally include `/sub/` segments — **unused today** because attach is absent.
5. **Message `content` JSONB** could theoretically carry agent tags without a new SQL column — **no writer stamps `agent_id`/`subagent_id` on progressive frames today**.
6. **Parent Main `subagent` tool_call cards** remain possible on Main (depth-0 tool bridge) as Main narrative — still not Worker process audit content.
7. **Local Node disk** `taskDir/subagents/<id>/` remains Runtime workspace (warm clears intentional settlement files per package) — not Case API replay.

**Out-of-scope candidates (still map-aligned unless Destination rewritten):** nested subagent recursion UI; full Main message-type parity in Worker dialog; cross-Case alias library; bidirectional user→Worker chat.

---

## 7. Explicit: no product recommendation

This ticket **does not** choose wire formats, storage location, dialog chrome, rename ownership, or live fidelity levels.

**Conflicts found:** none that force rewriting charting locks or Destination.

**Residual gaps (unchanged vs map intent):**

| Residual gap | One-line fact |
|--------------|---------------|
| Worker thinking/text wire | Package sessions never attach `PlatformTextStream` / session observability |
| Worker tools on Case | Policy A suppresses `tool_output` for `subagentDepth > 0` |
| Agent-scoped progressive frames | No `agent_id`/`subagent_id` on text/thinking sends |
| Case replay of Worker process | Messages store has no Worker transcript; only Main progressive + lifecycle raw types + panel roster |
| Worker audit dialog | Collaboration tree has no dialog open path |
| Case Worker rename | No Case-persistent display-name field/API |
| Multi-Package stacked transcript | One roster row + latest task; no package-turn timeline product surface |
| Continuous thread product surface | Identity continuity (id / Worker N / warm resume) exists; conversation audit surface does not |

---

## 8. Symbol index (revalidation anchors)

| Concern | Path |
|---------|------|
| Lifecycle + panel emit | `node4/src/runtime/subagent.ts` |
| Worker N ordinal | `node4/src/runtime/panel-agents.ts` |
| Silent Worker tools | `node4/src/runtime/run-node4-agent.ts` — `attachProductToolEventBridge`, `isSubagentPackageSession` |
| Child session (no stream attach) | `node4/src/runtime/subagent-session.ts` — `runSubagentLlmSession` |
| Main progressive streams | `node4/src/runtime/platform-observability.ts` — `PlatformTextStream`, `attachNode4SessionObservability` |
| Free Main attach | `node4/src/runtime/session-runner.ts` |
| Graph stage attach | `node4/src/runtime/hard-graph-stage-executor.ts` |
| Idle pool / keep-alive | `node4/src/runtime/subagent-idle-pool.ts`, `docs/specs/task-graph.md` |
| Free + Graph Tasks bind | `node4/src/runtime/subagent.ts` (`upsertFreeTodoChip`), `node4/src/stores/todo.ts`, `node4/src/runtime/hard-graph-plan.ts` |
| Case panel merge | `platform/backend/app/services/case_participants.py` — `merge_panel_agents` |
| Message schema | `platform/backend/app/models/message.py` |
| Live UI / render filter | `platform/frontend/src/pages/ConversationPage.tsx` |
| Tree UI | `platform/frontend/src/components/AgentCollaborationTree.tsx` |
| Numeric sort / presentation | `platform/frontend/src/lib/workerPresentation.ts` |
| Stream identity Spec | `docs/specs/stream-message-identity.md` (#276) |
| Harness / keep-alive Spec | `docs/specs/task-graph.md`, `docs/specs/harness.md` |

---

## 9. One-line gist (for map #253 Decisions)

**Revalidation on `origin/main` (`c940d8f`): #254/#255 gap gists still hold (no Worker process stream/persistence, no audit dialog, no Case rename); Spec #301/#302/#276 improved Tasks/sort/bind/keep-alive and Main stream identity only — charting locks not contradicted, open #256–#260 can proceed with light question refresh on #257/#258.**
