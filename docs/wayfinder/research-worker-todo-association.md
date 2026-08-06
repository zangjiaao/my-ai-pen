# Research: Worker ↔ Todo association path (Tasks panel) today

> Ticket: GitHub **#245** · Map **#242** Batch-1  
> Evidence: [evidence-session-6d8389f9-workers-plan.md](./evidence-session-6d8389f9-workers-plan.md) (#243) · Sort cross-check: [research-worker-list-sort-order.md](./research-worker-list-sort-order.md)  
> Scope: **facts only** (code + batch-1 evidence). No product decision.  
> Date: 2026-08-06  
> Branch: `research/worker-todo-association`

---

## One-line answer

For session `6d8389f9…`, **terminal Case plan_tree already links all 18 Workers** (`agent_id` / `linked_agent_id` / `owner_agent_name`). Operator-visible “Worker 4/6 without linked Todo” is **not** explained by a permanent missing backend association. It is explained by **one-way FE projection** (Tasks chip on Todo rows only; collaboration Workers never join reverse to a Todo), plus **mid-run timing**, **Tasks visibility caps/collapse**, and optional **chip-field** fragility — not by Worker-local todo wiping Main plan_tree.

---

## 1. Product law today: Main plan_tree vs worker-local todo

### Case Tasks SoT

| Layer | Who mutates Case Tasks | Wire |
|-------|------------------------|------|
| **Main / Graph captain** (`subagentDepth === 0`) | Yes — Todo tool + Hard Graph L2 | `todo_updated` **and** `plan_tree_updated` |
| **Worker / package child** (`depth >= 1`) | **No** for Case Tasks | `todo_updated` with `scope: "subagent_local"` only |

Normative harness (`docs/specs/harness.md` OMP table):

> Worker `todo` is local-only — must **not** emit Case `plan_tree_updated` (would wipe Main/Graph Tasks on the right panel).

Code (`node4/src/tools/todo.ts`):

- Subagent path: emit `todo_updated` with `scope: "subagent_local"`; **skip** `plan_tree_updated` and Graph `setStageTodos`.
- Main + Expert Graph: Todo is a facade over Graph L2 (`setStageTodos` + `emitHardGraphPlanTreeUpdate`).
- Main free path: `emitTodoPlanTreeUpdate` from TodoStore.

Test contract: `node4/src/tools/todo-subagent-plan-tree.test.ts` — subagent todo must not emit `plan_tree_updated`.

### How a Worker becomes “linked” to a Main Todo

Association is **not** “worker owns its private todo list on the right panel.”  
It is **host bind of a Worker chip onto a Case L2 work item** when Main spawns a package:

1. Main authors L2 todos on Case plan (via `todo` → Graph/Todo plan_tree).
2. Main spawns `subagent` with preferred `plan_node_id` / `todo_node_id` (todo tool returns `work_items[].node_id` + `plan_node_id_hint`).
3. Host `SubagentRuntime.upsertHardGraphPackageChip` → `HardGraphPlanStore.resolveWorkerBind`:
   - priority: **explicit** → **reattach** (same `agent_id`) → **single_free** (exactly one unbound L2) → **fuzzy** (title↔goal score) → else **`pkg-<subagentId>`** synthetic row.
4. Bind writes on the L2 node: `agent_id`, `linked_agent_id`, `owner_agent_name` (`Worker N`), optional status drive.
5. Host emits `plan_tree_updated` (`reason` like `subagent.running:…` / `subagent.done:…`).

Expert Graph packages **require** `plan_node_id` for formal ownership (Spec #116 I0.10); missing explicit id falls through bind paths and may create `pkg-*`.

Worker keep-alive / resume reuses `agent_id` via reattach — does not create a second Case todo by default.

---

## 2. Wire / events that associate Worker with Tasks row

### Parallel streams (intentionally decoupled)

| Event | Updates | Association role |
|-------|---------|------------------|
| `subagent_started` / `subagent_finished` | Often includes `panel_agents[]` | **Collaboration tree** roster (`StrixAgentList`); **not** Tasks join |
| `checkpoint_update` with `panel_agents` | Participant + snapshot roster | Same — agents only |
| `plan_tree_updated` | Full `plan_tree` (L1 stages + L2 work items) | **Tasks SoT** for checklist + Worker chips |
| `todo_updated` | `phases` / `open_count` / `scope` | Case progress signal; **not** the FE Tasks join key today (evidence: recent samples often lack flat `todos[]`) |

Platform persists `plan_tree_updated` onto Case participant (`_remember_participant_plan_tree` → `apply_plan_tree_to_participant`). Snapshot merges `plan_tree_from_participants` with checkpoint/message trees (`conversation_snapshot.py`).

### FE projection path

```
plan_tree_updated  → ConversationPage (250ms debounce, mergePlanTreeByOwner)
                   → RightPanel.planTree
                   → unifiedTodoItems(visiblePlanTree)   // work_item filter + slice(0, 40)
                   → GraphAwareTodoList / StrixTodoItem
                   → humanAgentChipName(item.owner_agent_name)  // chip only
```

```
panel_agents / subagent_* → setStrixAgents / mergeLivePanelAgents
                         → StrixAgentList (Agent collaboration)
                         → no reverse lookup into plan_tree
```

Facts about the chip:

- Tasks row is always a **Todo / work_item**, never a Worker-as-row (`kind === "worker"` filtered out; comment: *Workers live under Agent collaboration*).
- Chip label reads **`owner_agent_name` only** (`TasksPlanList.tsx`). It does **not** resolve `agent_id` → panel agent name as fallback.
- `agent_id` / `linked_agent_id` are carried on `PlanNode` types and preserved through live WS nodes, but **unused for chip paint**.

### Snapshot caveats (projection, not spawn)

- `checkpoint_plan_tree()` rebuilds nodes with a **fixed field allowlist that omits** `agent_id`, `linked_agent_id`, `owner_agent_name`.
- Snapshot prefers non-empty checkpoint tree **before** falling back to `message_plan_tree` (which keeps full message content).
- When participant plan exists, `merge_plan_trees_by_owner(participant_plan, raw)` prefers participant nodes (full stamps from live `plan_tree_updated`) — normal Expert path should keep chips.
- `preferRicherPlanTree` on FE can keep a prior live Graph tree when snapshot flattens stages; it does not re-join agents to todos.

Dedupe note: `_plan_tree_dedupe_key` hashes status/title/structure **without** ownership fields. Ownership-only updates with unchanged status merge into an existing DB row rather than inserting a new message; live WS still broadcasts, and merge updates content. Status-changing binds (pending→running→done) produce distinct digests.

---

## 3. Session `6d8389f9…`: were links missing?

### Terminal Product state (evidence #243)

| Metric | Value |
|--------|--------|
| Workers (`subagent_started`) | **18** |
| Latest `plan_tree_updated` L2 with agent fields | **18** (exactly the 18 workers) |
| L2 without agent | **27** (Main init/recon/surface/auth-style todos — expected unassigned) |
| Worker 4 / Worker 6 | **Both** have `agent_id` on todos (level5 XSS / level6 SSRF) |
| Progress | 45/45 done |

**Conclusion for this session at terminal:** links were **created and retained** on Case plan_tree. Not “never created.” Not “dropped permanently from Product plan_tree.”

### What “unlinked” can mean in the UI (without contradicting terminal DB)

| Interpretation | Supported? |
|----------------|------------|
| Backend never wrote `agent_id` for W4/W6 | **No** (terminal tree) |
| Collaboration Worker row has no Todo subtitle | **Yes by design** — tree does not join plan_tree |
| Tasks row for that work missing Worker chip mid-run | **Yes** — bind/emit after `subagent_started`; 250ms plan debounce |
| Tasks row exists with `agent_id` but empty chip | **Possible** if `owner_agent_name` empty/opaque and FE only paints name |
| Tasks row not visible (operator cannot find the link) | **Yes** — auto-collapsed done stages; **`unifiedTodoItems` `.slice(0, 40)`** with **45** work items at terminal |
| Lex sort of Worker names caused unlink | **No** — sort research: association is id/name on plan nodes, not list position |

Parallel wave at `11:05:13` (Workers 3–9 same second) is a high-risk window for **transient** orphans: roster updates on `subagent_started` before each chip lands on L2 via bind + `plan_tree_updated`.

`pkg-*` path: if explicit/fuzzy bind fails with multiple free todos, host creates `pkg-<subagentId>` with chip. That is still a linked Tasks row (synthetic), not a collaboration-only orphan. After later bind, pkg mirror is removed (`removeStageWorkItem`).

---

## 4. Failure modes that produce “orphan” Worker rows in UI

“Orphan” here = **Worker visible in Agent collaboration without an operator-visible Tasks association**.

| # | Mode | Layer | Permanent backend unlink? |
|---|------|-------|---------------------------|
| **A** | **One-way model** — Worker in roster; link only as chip on Todo | FE product surface | No |
| **B** | **Emit order race** — `panel_agents` before bind + `plan_tree_updated` | Wire timing | Transient |
| **C** | **Bind miss → `pkg-*`** or delayed fuzzy | Node host bind | Link exists as pkg or later Main row |
| **D** | **Chip field** — `owner_agent_name` missing/opaque; `agent_id` present | FE paint | Backend may still be linked |
| **E** | **Tasks visibility** — stage auto-collapse when all children terminal; flat cap **40** work items | FE filter | Backend complete |
| **F** | **Snapshot strip** — `checkpoint_plan_tree` drops ownership if participant plan empty / merge loses owned copy | Platform snapshot | Live message tree may still have links |
| **G** | **Main todo wipe by worker local todo** | Forbidden by law; tested | Should not happen on Node4 path |
| **H** | **Keep-alive / re-dispatch** without reattach status | Host | Usually reattach by `agent_id`; wrong stage id → temporary miss |
| **I** | **Misread** — expect Worker-as-Task-row; those rows are filtered out | FE intentional | N/A |

**Not failure modes for this evidence:**

- Lexicographic Worker list order (orthogonal; see sort research).
- Worker-local TodoStore “replacing” Case Tasks (explicitly blocked).

---

## 5. Verdict: FE projection vs missing backend link

| Question | Answer |
|----------|--------|
| Did terminal backend lack W4/W6 links? | **No** — plan_tree has all 18 |
| Is association a UI join of two live sets? | **No** — chip is a **stamped field on the todo node**; roster is a **separate** stream |
| Could operator honestly report “no linked Todo”? | **Yes** — reverse link absent in collaboration; mid-run gap; collapsed/capped Tasks list; chip-only paint |
| Primary bug class for #245 evidence | **FE / projection / presentation model** (and mid-run transient), **not** missing terminal backend association |

Recommended follow-on **verification** (out of scope for this research commit): replay first N `plan_tree_updated` after the 11:05:13 batch and check whether W4/W6 chips lag roster by wall time; count work items painted under `slice(0, 40)` for that tree.

---

## Code map (absolute paths)

| Concern | Path |
|---------|------|
| Worker local todo must not wipe Case | `/mnt/d/Coding/my-ai-pen/node4/src/tools/todo.ts`, `todo-subagent-plan-tree.test.ts` |
| Bind priority + chip fields | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-plan.ts` (`resolveWorkerBind`, `applyChip`) |
| Spawn → chip emit | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/subagent.ts` (`upsertHardGraphPackageChip`) |
| Harness law | `/mnt/d/Coding/my-ai-pen/docs/specs/harness.md` (OMP subagent scheduling) |
| Live plan_tree / agents | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/pages/ConversationPage.tsx` |
| Tasks filter + cap 40 | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/components/RightPanel.tsx` (`unifiedTodoItems`) |
| Chip paint | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/components/TasksPlanList.tsx`, `workerPresentation.ts` |
| Collaboration (no reverse join) | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/components/AgentCollaborationTree.tsx` |
| Participant plan persist | `/mnt/d/Coding/my-ai-pen/platform/backend/app/ws/router.py`, `case_participants.py` |
| Snapshot plan fields | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/conversation_snapshot.py` (`checkpoint_plan_tree` strip) |
| Session evidence | `/mnt/d/Coding/my-ai-pen/docs/wayfinder/evidence-session-6d8389f9-workers-plan.md` |

---

## Answers checklist (#245)

| # | Question | Answer |
|---|----------|--------|
| 1 | Product law Main vs worker-local todo | Worker todo is local-only; Case Tasks = Main/Graph plan_tree; host binds Worker chip to L2 via `plan_node_id` / fallthrough |
| 2 | Wire/events for association | `plan_tree_updated` stamps `agent_id`+`owner_agent_name` on L2; `panel_agents`/`subagent_*` drive collaboration only; FE chip = `owner_agent_name` |
| 3 | Session 6d8389f9 missing links | **Not missing at terminal**; operator report fits projection / mid-run / visibility — not “never created” or permanent drop |
| 4 | Orphan Worker failure modes | One-way UI, race, pkg/fuzzy, chip field, slice/collapse, snapshot strip; **not** worker todo wipe of Case plan |

---

## Handoff

- Product decision (if any later): reverse-link chrome on Workers, chip fallback from `agent_id`, raise/remove Tasks 40 cap, include ownership in checkpoint_plan_tree, or tighter spawn→bind ordering — **not decided here**.
- Sort lex issue remains separate (#242 sort research).
