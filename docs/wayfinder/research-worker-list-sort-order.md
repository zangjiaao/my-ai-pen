# Research: Worker list sort order in platform UI today

Facts only — **no product decision**.  
Ticket: GitHub [#244](https://github.com/zangjiaao/my-ai-pen/issues/244). Part of map [#242](https://github.com/zangjiaao/my-ai-pen/issues/242).  
Evidence: [evidence-session-6d8389f9-workers-plan.md](./evidence-session-6d8389f9-workers-plan.md) (session `6d8389f9…`, 18 workers).

---

## Question

Why does the Worker list order as `Worker 1`, `Worker 10`, `Worker 11`… instead of creation time / numeric index?

Surface:

1. Where Workers are labeled (`Worker N` string construction).
2. Where the list is sorted (client sort key, API order, or none).
3. Whether order is pure presentation or also affects Tasks panel / association.
4. Minimal fix surface candidates (FE natural sort vs stable `createdAt` order) — **candidates only**.

---

## Executive answer

| # | Surface | Finding |
|---|---------|---------|
| 1 | Label | **Node4** assigns a stable 1-based index per `subagent_id` and emits `name: "Worker ${n}"` (no zero-pad). FE trusts that string; does not invent ordinals from sibling index. |
| 2 | Sort | **Platform FE** re-sorts the roster with `orderStrixAgents`: depth → `parent_id` string → **`name.localeCompare(name)`**. Lexicographic name order produces exactly `Worker 1, 10, 11, …, 18, 2, …, 9`. Node/API emit spawn / merge order; they do **not** name-sort. |
| 3 | Tasks | **Presentation-only** for the collaboration tree. Tasks association is by `agent_id` / `owner_agent_name` on plan nodes, not by Worker list position. Tasks row order is an independent sort (priority / status / node_id). |
| 4 | Fix candidates | FE natural/numeric sort in `orderStrixAgents` (smallest surface); preserve Node emission order (drop name sort); optional wire `worker_index` / `createdAt` for stable keys — **not decided here**. |

Evidence session labels + lex hypothesis match the FE sort key exactly ([evidence](./evidence-session-6d8389f9-workers-plan.md) §1).

---

## 1. Where Workers are labeled (`Worker N`)

### Canonical sequencer (Node4)

**File:** `node4/src/runtime/panel-agents.ts`

- `PanelAgentTracker.workerIndexById` + `workerSeq`: first time a subagent id is seen, assign `++workerSeq` (1-based). Resume keeps the same number for the same id.
- `formatWorkerName(index)`:

```ts
export function formatWorkerName(index: number): string {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 1) return "Worker";
  return `Worker ${Math.floor(n)}`;
}
```

- On start: `noteSubagentStart` → `name = formatWorkerName(workerIndexFor(id))` into the panel child record.
- On end: reuses `prev?.name` or re-formats from the same index.
- `list()` returns `[main, ...this.children.values()]` — **Map insertion order** (= first-seen / spawn order), **not** sorted by name.

### Owner chip on plan rows (Node4)

**File:** `node4/src/runtime/subagent.ts` (`upsertHardGraphPackageChip`)

- Same sequencer: `workerIndexFor(subagentId)` + `formatWorkerName` → `owner_agent_name: "Worker N"`.
- Bind path uses `agent_id` + `owner_agent_name` on the plan work item — independent of UI list order.

### Platform FE presentation helpers

**File:** `platform/frontend/src/lib/workerPresentation.ts`

- `agentDisplayName`: if name matches `/^Worker\s+(\d+)\s*$/i`, re-emits `Worker ${digits}` (string of digits as-is; no padding).
- Explicit comment: *“Trusts clean Worker N from Node; never invents a wrong index.”* / *“Node PanelAgentTracker is the sole sequencer.”*
- `legacyWorkerDisplayName`: only reuses an existing clean `Worker N` for an id; otherwise plain `"Worker"` (no new ordinal).
- `humanAgentChipName`: Tasks chip shows clean `owner_agent_name` when it is a Worker name.

### Legacy / non-product paths (not the #242 session path)

- `ConversationPage.tsx` `worker_started` / `worker_finished` (Node2-style events): `name: \`Worker ${role}\`` where `role` defaults to `"worker"` — **not** the Node4 panel_agents sequencer. Product Node lineage is Node4 + `panel_agents`.
- Evidence session uses `subagent_started` + `panel_agents` / plan_tree — labels are `Worker 1`…`Worker 18` from the Node4 path above.

### Label facts (no sort yet)

- Format is the two-token string **`Worker` + space + decimal integer**, **no zero-pad**.
- Numeric *index* is stable per id and roughly spawn-order in a single run; evidence shows wall-clock first_start order can still disagree with label numbers across concurrent same-second batches (DB insert order vs index assignment), but labels themselves are not “level number” and not zero-padded.

---

## 2. Where the list is sorted

### Primary cause — client name sort

**File:** `platform/frontend/src/components/AgentCollaborationTree.tsx`  
**Call site:** `platform/frontend/src/components/RightPanel.tsx`

```ts
// RightPanel
const orderedStrixAgents = orderStrixAgents(strixAgents);
// … later displayAgents → <StrixAgentList agents={displayAgents} />
```

```ts
// orderStrixAgents
return [...agents].sort(
  (left, right) =>
    depth(left) - depth(right) ||
    String(left.parent_id || "").localeCompare(String(right.parent_id || "")) ||
    left.name.localeCompare(right.name),
);
```

For typical one-Main + N Workers under `parent_id: "node4-main"`:

1. Main has depth 0; Workers depth 1 → Main first.
2. Sibling Workers share the same parent → tie-break is **`name.localeCompare`**.
3. JavaScript default string compare is **lexicographic Unicode**, not natural/numeric:

| Lex order (what UI shows) | Numeric order |
|---------------------------|---------------|
| Worker 1, 10, 11, …, 18, 2, 3, …, 9 | Worker 1, 2, 3, …, 9, 10, …, 18 |

That matches the operator report and the evidence note’s lex-of-names check.

### Tree build does not re-sort children

`StrixAgentList` groups children by walking the **already ordered** `agents` array and appending in walk order. It parses ordinals from names only for display helpers (`workerOrdinalById`); it does **not** sort siblings by ordinal. Sibling order = order after `orderStrixAgents`.

### Node / backend — no name sort

| Layer | Order behavior |
|-------|----------------|
| Node4 `PanelAgentTracker.list()` | `[main, ...Map.values()]` — insertion / first-seen order |
| Backend `merge_panel_agents` (`case_participants.py`) | Main first; children **append/upsert by id**, walking prev then incoming — **preserve history order**, no `name` sort |
| Live FE `mergeLivePanelAgents` / message apply | Upsert into existing array; does not apply `orderStrixAgents` until RightPanel render |

So the **lexicographic Worker list is introduced at Status-tab render**, not at Node emit or Case merge.

### What is *not* the cause

- Not Object key order of a name→row map in the collaboration tree (array + explicit sort).
- Not SQL `ORDER BY name` on workers (roster is message/checkpoint `panel_agents` JSON).
- Not Tasks list sort bleeding into Workers (separate components / keys).

---

## 3. Presentation vs Tasks / association

### Collaboration tree (Workers panel)

- Pure **presentation order** from `orderStrixAgents`.
- Changing that sort does not rewrite `agent_id`, plan binds, or spawn semantics.

### Tasks panel

**Files:** `RightPanel.tsx` (`unifiedTodoItems`), `TasksPlanList.tsx`

- Workers as rows are **filtered out** of Tasks (`kind === "worker"` / worker source noise); comment: *“Workers live under Agent collaboration (not duplicated here).”*
- L2 todos show a **Worker chip** via `humanAgentChipName(item.owner_agent_name)` — string field on the plan node, not position in the Worker list.
- Association SOT for ownership is plan_tree fields (`agent_id`, `owner_agent_name`, optional `linked_agent_id` in evidence) resolved on Node bind (`resolveWorkerBind` / `plan_node_id`), not list index.
- Tasks sort (when flat-filtered): `priority` → status rank → `node_id|id|title` localeCompare — **independent** of Worker name order.

### Evidence cross-check ([#243 capture](./evidence-session-6d8389f9-workers-plan.md))

- Terminal plan_tree had **all 18** workers linked via `agent_id` / owner name.
- Reported “Worker 4/6 missing Todo” is **not** explained by list lex-order; association is id/name based. Sort research does not claim association bugs from this key (mid-run orphan / UI join remain separate research topics from the evidence handoff).

**Conclusion:** Worker list order is **pure presentation** for the collaboration tree. It does **not** drive Tasks row order or bind ownership.

---

## 4. Minimal fix surface candidates (no decision)

Candidates only — product chooses one later.

| Candidate | Where | Behavior | Notes |
|-----------|-------|----------|-------|
| **A. FE natural / numeric sort** | `orderStrixAgents` in `AgentCollaborationTree.tsx` | Parse `/^Worker\s+(\d+)$/i`, compare numbers; fallback `localeCompare` for non-Worker names | Smallest surface; matches operator expectation of “Worker 1…N”; no wire change |
| **B. FE preserve emission order** | Drop `name.localeCompare` (or only use it for non-Worker) | Order ≈ Node Map / merge append order (spawn / first-seen) | Numeric labels may still disagree with wall-clock (evidence: Worker 2 before Worker 1 start); order stable for a given roster array |
| **C. Wire `worker_index` (or reuse parsed N)** | Node already has index in tracker; optionally emit numeric field | FE sorts by `worker_index` | Explicit key; label string can stay unpadded; slightly more contract surface |
| **D. Wire `createdAt` / first_start** | Node panel record + FE | Sort by wall time | Closest to “creation time”; needs field not present on current `PanelAgentRecord` name-only rows; evidence used message `created_at` as proxy |
| **E. Zero-pad labels** (`Worker 01`) | `formatWorkerName` | Lex sort becomes numeric for &lt;100 | Cosmetic coupling; worse display; **not preferred** vs sort fix |
| **F. Sort in `StrixAgentList` only** | Sibling group after group-by | Same as A but local to tree | Equivalent UX if RightPanel always goes through list; `orderStrixAgents` is still used for any consumer of ordered flat roster |

**Not required for sort:** changing Tasks bind, plan_tree, or `merge_panel_agents` invariants — those are orthogonal to the lex presentation bug.

**Smallest likely engineering PR (candidate, not decision):** **A** — one comparator change (+ unit test that `Worker 2` precedes `Worker 10`).

---

## Code anchors (absolute paths)

| Concern | Path |
|---------|------|
| Name format + index | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/panel-agents.ts` (`formatWorkerName`, `workerIndexFor`, `list`) |
| Owner chip name | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/subagent.ts` |
| FE display trust | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/lib/workerPresentation.ts` |
| **Lex sort (root cause)** | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/components/AgentCollaborationTree.tsx` (`orderStrixAgents`) |
| Sort call site | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/components/RightPanel.tsx` |
| Case merge order | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/case_participants.py` (`merge_panel_agents`) |
| Tasks chip / filter | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/components/TasksPlanList.tsx`, `RightPanel.tsx` `unifiedTodoItems` |
| Prod evidence | `/mnt/d/Coding/my-ai-pen/docs/wayfinder/evidence-session-6d8389f9-workers-plan.md` |

---

## Answers checklist (#244)

| # | Question | Answer |
|---|----------|--------|
| 1 | Label construction | Node4 `formatWorkerName` → `Worker ${n}` from stable per-id index; FE trusts string |
| 2 | List sort | FE `orderStrixAgents` → `name.localeCompare` after depth/parent; Node/API not name-sorted |
| 3 | Tasks / association | Presentation-only; Tasks bind by `agent_id` / `owner_agent_name`; separate sort keys |
| 4 | Fix candidates | FE numeric sort (A); preserve emission order (B); wire index/createdAt (C/D); avoid zero-pad as primary fix (E) |

---

## Out of scope / not decided

- Whether UI *should* use numeric vs spawn vs createdAt order (product).
- Mid-run “missing Todo” association UX (evidence handoff; separate from sort).
- Node2 legacy `Worker ${role}` event path product relevance.
