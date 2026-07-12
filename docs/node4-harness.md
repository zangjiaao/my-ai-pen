# Node4 Agent Runtime — OMP-class harness, pentest role

> **Commercial clean-room design** (no oh-my-pi / OMP source dependency).  
> Calibrated: 2026-07-12  
> Role: **penetration testing agent**, not a coding agent.  
> Runtime: **OMP-class** (shell/write/edit/todo/continue/long session).  
> **No agent finish tool** — session end is harness/platform only.

Related: `product-roadmap.md`, `architecture.md`, `harness-v2.md` (Node2 lessons).

---

## 1. North star

```text
OMP-class loop:  Map(todo) → Act(shell/write/edit/http) → Book(finding+evidence)* → continue…
Product booking: structured tools only (never chat-only conclusions)
Task end:        platform / user cancel / natural stop / continue caps — NOT an agent finish tool; no session wall/max-time
Inspectability:  post-run task dir remains fully queryable (like OMP session files)
```

Node4 is **not** a coding agent. System prompt is **pentest** (scope, exploit, evidence).  
Harness mechanics follow OMP: high-density act tools, empty/premature-stop continue, durable sessions, todo map + session glue.

Interactive **TUI remains deferred**.

---

## 2. Principles

1. **Pentest role, OMP harness** — replace coding system prompt; keep bash/write/edit/todo/continue semantics.
2. **Booking ≠ stop** — `finding`/`evidence` may fire many times mid-run and **never** ends the loop.
3. **Chat is not product truth** — vuln/flag/auth only via `finding` + `evidence_ids`.
4. **No agent finish tool** — there is no `finish_scan` / agent `status` end tool. `task_complete` is harness/platform settlement after budgets or idle-stop cap.
5. **Findings alone ≠ job done** — having N findings does not stop attacking or force completed mid-loop.
6. **Post-run inspectability** — after dispose, operators can read task workspace artifacts without a live process.
7. **No OMP source** — clean-room only.
8. **No target answer keys**.

---

## 3. Main loop

| Step | Behavior |
|------|----------|
| Start | Task envelope → durable task dir; eager-todo injection on first prompt |
| Map | `todo` phases (content-keyed; single in_progress; auto-promote) |
| Act | `shell`, `write`, `edit`, `read`, `http`, `script` under task cwd |
| Book | `finding` + auto/manual evidence (repeatable) |
| Continue | **OMP-like, rare**: empty-stop retries (default 1) or **one** booking-gap continue if evidence exists but 0 findings. **Not** “pad until wall”. After tools then stop → **natural end** |
| Session wall / max-time | **None** by design (OMP default style). Only platform/user cancel aborts the session. Per-tool shell timeouts remain. |
| Settle | Runner emits `task_complete` when agent naturally stops / empty-stop cap / wall / abort |

---

## 4. Role packs (extensible)

Explicit structured `TaskEnvelope.engagement` / `role` selects a **role pack** (no free-text NLP).  
Default: `pentest`. Stub extension: `consult` (no finding tool). Register more via `registerRolePack`.

| Pack | Tools (summary) | Booking |
|------|-----------------|---------|
| `pentest` | todo, shell, fs, http, script, finding, subagent, goal | finding+evidence |
| `consult` (stub) | todo, shell, read, goal | none |

See `src/roles/` and `docs/node4-roadmap-memo.md`.

## 5. Tools (pentest pack)

| Tool | Role |
|------|------|
| `todo` | Progress map (OMP-class ops) |
| `shell` | High-density bash; specialist scanners via shell when installed; process-group kill on timeout/wall |
| `write` / `edit` / `read` | File iteration under task dir |
| `http` | Single HTTP probe |
| `script` | Optional multi-file run helper |
| `finding` | **Only** product conclusion path (when pack.bookingMode=finding) |
| `subagent` | Child work package → structured result + evidence |
| `goal` | Long-task anchors (do not hard-gate settlement) |

**P1 posture:** Prefer shell + environment/sandbox (browser, sqlmap, nuclei, Caido) over a large first-class tool catalog.  

**Not present:** `finish_scan`, agent `status` end tool, or any agent-callable terminal.

---

## 6. Subagent + goals

| Mechanism | Behavior |
|-----------|----------|
| `subagent` tool / `SubagentHost` | Spawn child under `taskDir/subagents/<id>`; worker returns structured data; **evidence** always written |
| `goal` store/tool | Open/done/dropped anchors; attach subagent ids; re-injected on continue; **not** required empty for settle |
| Platform events | `subagent_started` / `subagent_finished` / `goal_updated` |

## 7. Todo session glue (OMP-class, clean-room)

**Usage style (aligned to OMP lab runs):** light coarse map — **one** `init` with phases + category-level tasks, then **occasional** `done` when a whole category/phase is largely finished. **Not** a per-challenge / per-finding ledger. Prefer shell density over frequent todo updates.

| Mechanism | Behavior |
|-----------|----------|
| Tool description | Content-id rules, ops table, auto-promote; sparingly / coarse-only guidance |
| Eager todo | First prompt: forced coarse `todo.init` (categories, not micro-items) |
| Mid-run nudge | Only if open count ≥ 3; tells agent not to bookkeep per probe |
| Error reminder | Failed todo sets pending errors; next continue injects retry once |
| Summary | Remaining items + active phase + full tree (OMP-shaped) |
| Eager booking | First prompt: book via `finding` (may batch after a shell burst) |
| Booking backlog nudge | Continue when evidence≫0 and findings=0 (or evidence far ahead) |

Open todos never block booking or harness settlement. Booking is product truth; chat is not.

---

## 8. Booking vs lifecycle

| Concern | Mechanism |
|---------|-----------|
| Evidence | Tool outputs may create evidence records |
| Confirmed vuln/flag/auth | `finding` only |
| End of billing/session | Harness: wall budget, continue cap, abort → `task_complete` |

Terminal status policy (harness):

- `completed` if ≥1 evidence-backed finding **and** loop ended without abort  
- else `incomplete`  

---

## 9. Post-run inspectability (OMP-like)

Each task directory retains at least:

| Path | Content |
|------|---------|
| `events.jsonl` | Platform/tool events |
| `transcript.jsonl` | Serialized agent messages after run |
| `session-manifest.json` | Index of artifact paths + terminal status |
| `pi-sessions/` | Pi session manager files |
| `findings/`, `evidence/`, `scripts/` | Product + act artifacts |

Operators reconstruct the run offline by reading this directory.

---

## 10. Platform events

| Event | Meaning |
|-------|---------|
| `tool_output` | Act/tool progress |
| `evidence_created` / `vuln_found` | Booking |
| `todo_updated` | Progress map |
| `status_update` | Harness progress notes (not agent finish) |
| `task_complete` | **Harness** terminal settlement only |

---

## 11. Node2 coexistence

Node2: legacy (may still expose `finish_scan`). Node4: capability path. Same platform channel, different loop.

---

## 12. Non-goals

- oh-my-pi dependency  
- Full TUI / sticky todo panel  
- Coverage/worker ceremony  
- Hardcoded lab answers  
- Exact OMP score parity  
- Agent finish/status end tool  
- Node↔Node P2P multi-agent mesh (collaboration is **platform-orchestrated**; see memo)  

---

## 13. Related memos (not implementation specs)

- **`node4-roadmap-memo.md`** — multi-role (CTF / remediate / IR), multi-env Node registration, multi-agent via platform only; **no large Node4 rewrite required now** for future collaboration.  
- Optional later: envelope pass-through fields (`role`, `parent_task_id`) without consuming them in the runner.
