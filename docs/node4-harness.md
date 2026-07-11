# Node4 Agent Runtime — clean-room OMP-inspired harness

> **Commercial execution north star** for a new pentest node.  
> Calibrated: 2026-07-11  
> **Not** a dependency on oh-my-pi / OMP source. Learn structure; implement in-house.

Related: `harness-v2.md` (Node2 simplification lessons), `product-roadmap.md`, `architecture.md`.

---

## 1. North star

Node4 is a **simple authorized attack harness** that maximizes agent skill:

```text
Understand → Map (todo) → Act (http / script) → Book (finding + evidence) → Close (finish once)
```

Same product platform as Node2; **different default loop** — no conversion matrix, no mandatory workers, no checklist finish prison.

Interactive **TUI is deferred** (reserved for a later goal). This release: headless/standalone + platform WS.

---

## 2. Clean-room principles

1. **Simple is strong** — default tools: `todo`, `http`, `script`, `finding`, `finish_scan` (+ optional `read` from Pi).
2. **Script/shell-first for multi-step** — write → run → iterate under workspace/sandbox constraints.
3. **Todo is a map** — content-string IDs, single `in_progress`, auto-promote; **never blocks** completed alone.
4. **Book after proof** — `finding` with `evidence_ids` only.
5. **One finish settlement** — tool accept is authoritative; session must not demote `completed` → `incomplete` via second conversion gate.
6. **No OMP/oh-my-pi in the product tree** — no vendor, no fork-as-dependency, no pasted upstream sources.
7. **No target answer keys** — no DVWA/Juice/CTF hardcoded flags.
8. **Node2 coexistence** — Node2 remains available; Node4 is the capability path forward.

---

## 3. Main loop

| Step | Action | Tool |
|------|--------|------|
| 1 | Scope + target | task envelope |
| 2 | Phase map | `todo` init |
| 3 | Probe / exploit | `http`, `script` |
| 4 | Confirm | `finding` + evidence |
| 5 | Advance | `todo` done |
| 6 | End | `finish_scan` once |

Workers, coverage matrices, multi-workflow DAGs are **non-default** (not shipped as ceremony).

---

## 4. Default tools (intent)

| Tool | Role |
|------|------|
| `todo` | Progress map |
| `http` | Single HTTP request in scope |
| `script` | Write/read/run `.py`/`.js` under task workspace (timeout-bounded) |
| `finding` | Confirm vuln/flag/auth with evidence |
| `finish_scan` | Terminal completed/incomplete/blocked |

Sandbox: scripts run with process timeout and task cwd isolation; production should keep Docker isolation aligned with Node2 when available.

---

## 5. Platform event mapping

Inbound (same as Node2):

- `task_assign` → start run
- `user_steer` / interrupt (minimal: abort current burst)

Outbound:

| Event | When |
|-------|------|
| `status_update` / `text` | Progress narration |
| `tool_output` | Tool start/end |
| `evidence_created` | Evidence written |
| `vuln_found` | Finding confirmed |
| `todo_updated` / `plan_tree_updated` | Todo projection |
| `finish_scan_requested` | Finish tool accepted |
| `task_complete` | Terminal; status matches finish settlement |
| `task_error` | Hard failure |

**Rule:** If `finish_scan` accepted `completed`, `task_complete.status` is `completed` (no demotion).

---

## 6. Node2 coexistence

| | Node2 | Node4 |
|--|-------|-------|
| Role | Legacy full harness | Simple capability runtime |
| Default loop | Heavy / hybrid v2 | OMP-philosophy clean-room |
| Platform | Existing | Same channel, own `NODE_TOKEN` / name |
| Transition | Keep for compat | Promote when labs match product bar |

---

## 7. TUI

**Deferred.** No OMP-like interactive TUI in this goal.  
Reserved later: sticky todo + transcript sharing the same todo/finding events.  
MVP may log to stdout only.

---

## 8. Delivery phases

1. Docs (this page)  
2. Standalone runtime + unit smokes  
3. Lab capability comparison vs OMP baselines (standalone first)  
4. Platform WS bridge + smoke  
5. Final comparison note + TUI remains deferred  

---

## 9. Non-goals

- Shipping oh-my-pi as dependency  
- Full TUI clone  
- Coverage conversion gates as default finish path  
- Multi-specialist nodes  
- Hardcoded lab answers  
