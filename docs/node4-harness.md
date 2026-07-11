# Node4 Agent Runtime — OMP-class harness, pentest role

> **Commercial clean-room design** (no oh-my-pi / OMP source dependency).  
> Calibrated: 2026-07-12  
> Role: **penetration testing agent**, not a coding agent.  
> Runtime: **OMP-class** (shell/write/edit/todo/continue/long session).  

Related: `product-roadmap.md`, `architecture.md`, `harness-v2.md` (Node2 lessons).

---

## 1. North star

```text
OMP-class loop:  Map(todo) → Act(shell/write/edit/http) → Book(finding+evidence)* → continue…
Product booking: structured tools only (never chat-only conclusions)
Task end:        platform / user / wall-budget / empty-stop cap — NOT agent finish_scan(completed)
Inspectability:  post-run task dir remains fully queryable (like OMP session files)
```

Node4 is **not** a coding agent. System prompt is **pentest** (scope, exploit, evidence).  
Harness mechanics follow OMP: high-density act tools, empty/premature-stop continue, durable sessions.

Interactive **TUI remains deferred**.

---

## 2. Principles

1. **Pentest role, OMP harness** — replace coding system prompt; keep bash/write/edit/todo/continue semantics.
2. **Booking ≠ finish** — `finding`/`evidence` may fire many times mid-run and **never** ends the loop.
3. **Chat is not product truth** — vuln/flag/auth only via `finding` + `evidence_ids`.
4. **No agent-driven early complete** — agent `status` is a non-terminal progress note; `task_complete` is harness/platform settlement after budgets or idle-stop cap.
5. **Findings alone ≠ job done** — having N findings does not stop attacking or force completed mid-loop.
6. **Post-run inspectability** — after dispose, operators can read task workspace artifacts without a live process.
7. **No OMP source** — clean-room only.
8. **No target answer keys**.

---

## 3. Main loop

| Step | Behavior |
|------|----------|
| Start | Task envelope → durable task dir |
| Map | `todo` phases |
| Act | `shell`, `write`, `edit`, `read`, `http`, `script` under task cwd |
| Book | `finding` + auto/manual evidence (repeatable) |
| Continue | On natural stop: empty/premature-stop continue up to cap; wall budget hard stop |
| Settle | Runner emits `task_complete` from harness policy (not agent finish) |

---

## 4. Tools

| Tool | Role |
|------|------|
| `todo` | Progress map |
| `shell` | Task-scoped command execution (OMP-like bash density) |
| `write` / `edit` / `read` | File iteration under task dir |
| `http` | Single HTTP probe |
| `script` | Optional multi-file run helper |
| `finding` | **Only** product conclusion path |
| `status` | Non-terminal engagement note (optional); does **not** end loop |

Legacy name `finish_scan` may alias `status` for protocol compatibility but **must not** terminate the agent loop or alone force `task_complete=completed`.

---

## 5. Booking vs lifecycle

| Concern | Mechanism |
|---------|-----------|
| Evidence | Tool outputs may create evidence records |
| Confirmed vuln/flag/auth | `finding` only |
| Mid-run report text | `status` optional |
| End of billing/session | Harness: wall budget, continue cap, abort → `task_complete` |

Terminal status policy (harness):

- `blocked` if agent booked a blocked status note with reason  
- else `completed` if ≥1 evidence-backed finding **and** loop ended by budget/continue-cap (work happened)  
- else `incomplete`  

Agent cannot emit terminal complete merely by calling finish with findings mid-flight.

---

## 6. Post-run inspectability (OMP-like)

Each task directory retains at least:

| Path | Content |
|------|---------|
| `events.jsonl` | Platform/tool events |
| `transcript.jsonl` | Serialized agent messages after run |
| `session-manifest.json` | Index of artifact paths + terminal status |
| `pi-sessions/` | Pi session manager files |
| `findings/`, `evidence/`, `scripts/` | Product + act artifacts |
| `status.json` | Last non-terminal status note if any |

Operators reconstruct the run offline by reading this directory.

---

## 7. Platform events

| Event | Meaning |
|-------|---------|
| `tool_output` | Act/tool progress |
| `evidence_created` / `vuln_found` | Booking |
| `todo_updated` | Progress map |
| `status_update` / non-terminal status | Notes |
| `task_complete` | **Harness** terminal settlement only |

---

## 8. Node2 coexistence

Node2: legacy. Node4: capability path. Same platform channel, different loop.

---

## 9. Non-goals

- oh-my-pi dependency  
- Full TUI  
- Coverage/worker ceremony  
- Hardcoded lab answers  
- Exact OMP score parity  
