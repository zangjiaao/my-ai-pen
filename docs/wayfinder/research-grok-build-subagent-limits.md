# Research: Does Grok Build limit Subagent count?

> **Question:** Grok Build 会不会限制 Subagent 数量？  
> **Scope:** Grok Build TUI / agent harness (`spawn_subagent`, workflows, skills). Product Node4 alignment after Spec #302 is summarized in §7 (non-normative).  
> **Date:** 2026-08-07  
> **Primary sources:** `~/.grok/docs/user-guide/16-subagents.md`, `05-configuration.md`, `14-headless-mode.md`, `20-background-tasks.md`; bundled skills `create-workflow`, `execute-plan`; live tool schema for `spawn_subagent` / `workflow` as exposed to the agent.

---

## Executive answer

| Kind of limit | Exists? | What it is |
|---------------|---------|------------|
| **Hard cap on how many sibling subagents a parent may spawn (total or concurrent)** | **Not documented** as a product-wide number | Official subagents guide documents enable/disable, depth, types, models — **not** “max N subagents per session” |
| **Nesting depth** | **Yes** | Max depth **1**: only the top-level session may spawn; a subagent cannot spawn children |
| **On/off** | **Yes** | `GROK_SUBAGENTS=0` or `[subagents] enabled = false` disables spawning entirely |
| **Type allow/deny** | **Yes** | Per-type toggle; headless `--disallowed-tools Agent` / `Agent(explore)` |
| **Workflow run budget** | **Yes (workflows only)** | Default **128** logical agent calls per workflow run; configurable **1–1024** via `agent_budget` |
| **Skill-level concurrency** | **Yes (specific skills)** | e.g. `/execute-plan --concurrency` **1–8** (default **4**) — policy of that skill, not global Grok Build |
| **Wait API batch size** | Minor | `get_command_or_subagent_output` / wait path documents **max 20** task IDs per wait call (orchestration batching, not spawn cap) |

**Bottom line:** Grok Build **does not** publish a global “you may only have K concurrent Subagents” limit for normal `spawn_subagent` use. It **does** limit **nesting**, allow **disabling** subagents, and apply **run budgets** inside **workflows** and some **skills**. Soft limits (rate limits, tokens, machine resources) are outside this doc.

---

## 1. Official Subagents guide (product contract)

Source: `~/.grok/docs/user-guide/16-subagents.md`

### What is a Subagent

- Independent child session for parallel work; own context window; summary back to parent when finished.  
- Enabled by default.

### Disabling (not a count limit)

```bash
export GROK_SUBAGENTS=0
```

```toml
[subagents]
enabled = false
```

### Spawn surface

Documented `spawn_subagent` parameters: `prompt`, `description`, `subagent_type`, `background`, `capability_mode`, `isolation`, `resume_from`, `cwd`.  
**No** documented parameter for “max concurrent” or “quota remaining.”

Built-in types: `general-purpose`, `explore`, `plan` (+ project/user-defined agents).

### Depth limit (hard)

From the same guide, section **Depth Limits**:

> Only the top-level session spawns subagents. A subagent cannot spawn its own subagents: the maximum nesting depth is one. If a subagent calls `spawn_subagent`, the call fails with a depth-limit error.

This is a **tree-depth** limit, not a **sibling count** limit. The parent may still spawn many children in parallel (subject to host resources / model policy not stated as N).

### Config knobs (no count)

`~/.grok/docs/user-guide/05-configuration.md` documents:

```toml
[subagents]
enabled = true

[subagents.toggle]
explore = true
plan = false

[subagents.models]
explore = "grok-build"
```

Env: `GROK_SUBAGENTS` enable/disable.  
**No** `max_concurrent` / `max_subagents` key in the documented config surface.

---

## 2. Headless / tools controls

Source: `~/.grok/docs/user-guide/14-headless-mode.md`

- `--disallowed-tools Agent` — block **all** subagent spawning.  
- `--disallowed-tools Agent(explore)` — block only `explore`.  
- Again: permission/deny by type, **not** a numeric cap.

Usage accounting mentions subagent tokens may be incomplete under cancel/incomplete runs — billing/observability, not a spawn count limit.

---

## 3. Workflows (`workflow` tool / Rhai scripts)

Source: `~/.grok/bundled/skills/create-workflow/SKILL.md` (+ tool description exposed to the agent)

| Cap | Value | Meaning |
|-----|--------|---------|
| Default `agent_budget` | **128** | Cumulative logical agent calls per **workflow run** |
| Max `agent_budget` | **1024** | Hard upper bound for that tool parameter |
| Min `agent_budget` | **1** | |
| `parallel()` panel | Atomic admit against budget | If a panel would exceed remaining budget, **none** of its new jobs launch |

Also: “There's **no lower concurrency throttle**” for workflow parallel panels — admission is budget-based, not “only 2 at a time” by default.

This applies when using the **workflow** orchestration path, **not** every free-form chat turn that calls `spawn_subagent`.

---

## 4. Skill-specific concurrency (not global)

Source: `~/.grok/bundled/skills/execute-plan/SKILL.md`

| Flag | Range | Default |
|------|--------|---------|
| `--concurrency` | **1–8** | **4** |

Meaning: max **parallel implementation subagents** for `/execute-plan` orchestration.  
This is skill policy, not a Grok Build kernel default for all sessions.

Other skills (e.g. wayfinder firing multiple research subagents) do not document an additional global cap beyond depth + enable.

---

## 5. Background wait batching

Source: `~/.grok/docs/user-guide/20-background-tasks.md`

- Wait helpers accept a list of task IDs with a documented **maximum of 20** IDs per wait call.  
- Scheduled tasks: **maximum 50** active at once.  

These bound **wait/schedule bookkeeping**, not “only 20 subagents may ever exist.”

---

## 6. Live agent tool surface (this environment)

The `spawn_subagent` tool description provided to the main agent in-session matches the user guide: types, isolation, `resume_from`, capability modes; **depth restriction** is reinforced by product rules (subagents do not spawn subagents).  

No tool argument encodes “remaining spawn quota.”

The `workflow` tool description explicitly includes `agent_budget` **1–1024**, default **128**.

---

## 7. Product Node4 Subagents (Spec #302 — aligned with this research)

**Normative product law:** `docs/specs/harness.md` / `docs/specs/task-graph.md` (this note is non-normative comparison).

After Spec #302, Node4 product limits are Grok-like:

| Mechanism | Node4 (product) |
|-----------|-----------------|
| Nesting | Depth **1** (Worker cannot spawn subagent) |
| Same-path dispatch count | **No hard kill** (observability only) |
| Concurrency | `NODE4_SUBAGENT_CONCURRENCY` default **8** (1–16) = **queue scheduler only** |
| Batch length | `MAX_SUBAGENT_BATCH` **32** — abuse ceiling hard error |
| Cumulative task budget | `NODE4_SUBAGENT_TASK_BUDGET` default **128** (max **1024**) |

Historical repro: session `1bd28e1f…` (8 packages → 2 Workers under old `MAX_PATH_DISPATCHES=2`) is **pre-#302**.

A session-compaction metric `max_concurrent_subs` seen under Grok session logs is from **my-ai-pen bench JSON**, not Grok Build configuration.

---

## Claims table (source-backed)

| Claim | Source |
|-------|--------|
| Subagents enabled by default; parallel independent sessions | `16-subagents.md` intro |
| Disable via `GROK_SUBAGENTS` / `[subagents] enabled` | `16-subagents.md` § Disabling; `05-configuration.md` |
| Nesting depth max **1** | `16-subagents.md` § Depth Limits |
| No documented global concurrent count | Absence in `16-subagents.md` spawn table + config § Subagents |
| Headless can block all/type of Agent tools | `14-headless-mode.md` |
| Workflow `agent_budget` default 128, max 1024 | `create-workflow` skill + `workflow` tool schema |
| execute-plan concurrency 1–8 default 4 | `execute-plan` skill |
| Wait list max 20 task IDs | `20-background-tasks.md` |
| Product Node4 post-#302 ≈ Grok shape (no path-count kill; task budget 128) | Spec #302; `node4/src/runtime/concurrency.ts` |

---

## Residual uncertainty

- Grok Build’s closed-source host may enforce **undocumented** soft concurrency for resource protection; **not stated** in user-guide primary docs reviewed here.  
- Model provider rate limits can cause practical throttling that looks like a “limit” but is not a Subagent count policy.  
- Exact error string for depth-limit failure is described as “depth-limit error” in docs; not re-triggered in this research run.

---

## Practical takeaway for operators

1. **Grok Build** will not, by documented policy, stop you at “only 2 Subagents.”  
2. It **will** refuse **nested** `spawn_subagent` from a child.  
3. **Workflows** can stop after **128** (or your) agent_budget logical calls.  
4. **Skills** like execute-plan may run only **4** implementers in parallel by default.  
5. If product UI shows 2 Workers after “8 Subagents,” check **Node4 path/concurrency budgets**, not Grok Build.
