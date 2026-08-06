# Evidence: session `6d8389f9-8fe7-4c18-869e-4a915a8d160a` (Workers / plan tree)

> Wayfinder task: **#243** · Map **#242** Batch-1  
> Host: `64.90.7.192:22889` (read-only)  
> Captured: 2026-08-06 · Source: Postgres `pentest_platform.messages` + `conversations`  
> **No secrets** in this note.

## Conversation

| Field | Value |
|-------|--------|
| `conversation_id` | `6d8389f9-8fe7-4c18-869e-4a915a8d160a` |
| title | 新会话 |
| status | `completed` |
| node_id | `5c2f6a57-7293-4833-aa63-159cb03e8d9d` |
| created_at | 2026-07-29 10:52:10 UTC |
| last_active_at | 2026-07-30 01:23:08 UTC |
| expert (context) | `23268f25-fdfa-441d-9606-c953065a4242` · engagement `app_assessment` / pentest |
| task_id (node workspace) | `6ca97332-81ca-450e-a704-460340e36c5a` |
| message counts | 848 total; `subagent_started`×18; `subagent_finished`×18; `plan_tree_updated`×71; `todo_updated`×197 |

Deploy tree: `/opt/my-ai-pen` → `/data/opt/my-ai-pen`. Services `my-ai-pen-backend` / `my-ai-pen-node4` active.  
Git working tree on host may not expose a clean `rev-parse` in capture window (deploy uses rsync/copy layout).

## 1. Workers (18)

From `msg_type=subagent_started`, **first occurrence** of each `subagent_id` (spawn order ≈ wall time; same-second batch order is DB insert order):

| # | Display name | `subagent_id` | First start (UTC) | Assignment (abbrev.) |
|---|--------------|---------------|-------------------|----------------------|
| 1 | Worker 2 | `sub_1785322746437_12` | 10:59:06 | level2 RCE probe |
| 2 | Worker 1 | `sub_1785322746437_11` | 10:59:06 | level1 SQLi probe |
| 3 | Worker 3 | `sub_1785323113348_13` | 11:05:13 | level3 upload |
| 4 | Worker 5 | `sub_1785323113348_14` | 11:05:13 | level4 LFI |
| 5 | Worker 6 | `sub_1785323113348_16` | 11:05:13 | level6 SSRF |
| 6 | Worker 4 | `sub_1785323113348_15` | 11:05:13 | level5 XSS |
| 7 | Worker 7 | `sub_1785323113348_17` | 11:05:13 | level7 unserialize |
| 8 | Worker 9 | `sub_1785323113349_19` | 11:05:13 | level9 captcha |
| 9 | Worker 8 | `sub_1785323113348_18` | 11:05:13 | level8 IDOR |
| 10–17 | Worker 10–17 | `sub_1785324046816_20` … `_22` | 11:20:47 | “验证” wave (levels 1–8, order ≠ label) |
| 18 | Worker 18 | `sub_1785324098997_28` | 11:21:39 | level9 验证 |

**Facts for sort cluster:**

- Display labels are strings `Worker ${n}` (no zero-pad, no separate `createdAt` field on the wire name).
- Chronological start order ≠ numeric label order (e.g. Worker 2 starts before Worker 1 in this capture; Worker 4/5/6 labels do not match level numbers).
- **Lexicographic sort of names** produces exactly:  
  `Worker 1, 10, 11, …, 18, 2, 3, …, 9` — matches operator report of UI order.

## 2. Plan tree / Todos (terminal state)

Latest `plan_tree_updated`:

- `plan_tree`: **52** nodes (stages + todos)
- Non-stage todos: **45**
- With `agent_id` / `linked_agent_id`: **18** (exactly the 18 workers)
- Without agent: **27** (init / recon / surface / auth_session / authz_logic style Main todos)
- `progress`: `45/45 done (0 open)`, `todo_open_count`: 0

**Every worker is linked** on terminal plan_tree, e.g.:

| Worker | Todo title (abbrev.) | `agent_id` |
|--------|----------------------|------------|
| Worker 1 | level1 login+blind 探测 | `sub_…_11` |
| Worker 4 | level5 XSS | `sub_…_15` |
| Worker 6 | level6 SSRF | `sub_…_16` |
| … | … | … (all 18) |

Sample todo fields: `agent_id`, `linked_agent_id`, `owner_agent_name` (`Worker N`), `owner_expert_id/name`, `parent_id` (graph stage), `status`, `title`.

**Implication for “Worker 4/6 没有关联 Todo”:**

- **Not supported by terminal Product plan_tree** — both Worker 4 and 6 have `agent_id` on todos.
- Likely explanations for research to test (not decided here):
  1. **UI projection**: Workers panel sorted/lex-displayed independently of Tasks rows; join by `agent_id` fails or only shows Main todos.
  2. **Mid-run gap**: worker appears in `panel_agents` before plan_tree assigns `agent_id` (transient orphan).
  3. **Misread**: Tasks show todo *title* without worker chip; operator expected bidirectional link chrome.

`todo_updated` events (197) use a different shape (`phases` / `open_count`, often no flat `todos[]` in recent samples) — platform may prefer **`plan_tree_updated` as Tasks SOT** for association.

## 3. Node workspace / subagents

- Task dir present: `node4/workspace/6ca97332-81ca-450e-a704-460340e36c5a/`
- `subagents/` listing at capture time: **empty** (likely cleaned after completion; DB messages remain SOT for historical workers).

## 4. Logs

Not bulk-exported (bounded). Worker spawn is fully reconstructible from `subagent_started` + `panel_agents` snapshots in messages. Platform/Node journal pull optional if research needs timestamps beyond message `created_at`.

## 5. Answers checklist (#243)

| # | Question | Answer |
|---|----------|--------|
| 1 | How many Workers / ids / labels / times | **18**; table above; labels `Worker N`; first_start times above |
| 2 | Tasks/Todo/plan_tree links | Terminal plan_tree links **all 18** via `agent_id`; 27 Main todos unassigned |
| 3 | Subagent dirs | Task id known; on-disk subagent dirs empty post-run |
| 4 | Logs around spawn | Message stream sufficient; optional journal later |
| 5 | Deploy revision | Host deploy at `/data/opt/my-ai-pen`; clean git sha not confirmed in this capture |

## Research handoff

- **Sort:** FE/API almost certainly string-sorts `Worker N` names → natural/numeric/createdAt order is the product decision for grilling.
- **Association:** Terminal data has links; investigate UI join + mid-run emission order before treating as missing backend association.
