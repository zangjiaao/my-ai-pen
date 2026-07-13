# Node4 Agent Runtime — OMP-class harness

> **Commercial clean-room design** (no oh-my-pi / OMP source dependency).  
> Calibrated: 2026-07-13  
> **This is the only product Node runtime.** Code lives in `node4/`.  
> **Expert packs** live under repo **`experts/`** (catalog); Node **installs** copies into a local install root to enable them.  
> Legacy trees (`node/`, `node2/`, `node3/`) are reference-only and will be removed later.  
> **No agent finish tool** — session end is harness/platform only.

Related product specs: `docs/prd.md`, `AGENTS.md`, `docs/node-expert-offers.md`, `docs/node4-ctf-role.md`, `experts/README.md`.

---

## 1. North star

```text
OMP-class loop:  Map(todo) → Act(shell/write/edit/http…) → Book(finding+evidence)* → continue…
Product booking: structured tools only (never chat-only conclusions)
Task end:        platform / user cancel / natural stop / continue caps — NOT an agent finish tool
Inspectability:  post-run task dir remains fully queryable
```

Node4 is **not** a coding agent. Role packs supply mission + tool surface (default **pentest**).  
Harness mechanics: high-density act tools, empty/premature-stop continue, durable task dirs, light todo map.

Interactive **TUI remains deferred**.

---

## 2. Principles

1. **OMP harness, role-specific mission** — keep bash/write/edit/todo/continue density; swap pack prompt/tools, not the runner.
2. **Booking ≠ stop** — `finding`/`evidence` may fire many times and **never** ends the loop.
3. **Chat is not product truth** — vuln/flag/auth only via `finding` + `evidence_ids` when pack books findings.
4. **No agent finish tool** — no `finish_scan` / agent terminal status tool. `task_complete` is harness/platform settlement.
5. **Findings alone ≠ job done** — N findings do not force mid-loop completed.
6. **Discovery in-loop** — keep acting while concrete untested hypotheses remain; do not drive the loop from a coverage matrix gate.
7. **Simple is strong** — prefer shell + environment (sandbox browser, scanners via shell) over a large mandatory first-class catalog. Extra tools (session, browser, skill) are **assistive**, not process prisons.
8. **Harness over restriction** — weak behavior → prompt / envelope / assistive tools first; not answer keys, expected vuln counts, or default validators.
9. **No target answer keys**.
10. **Post-run inspectability** — task workspace readable after dispose.

---

## 3. Main loop

| Step | Behavior |
|------|----------|
| Start | Task envelope → durable task dir; coarse todo injection on first prompt |
| Map | `todo` phases (content-keyed; single in_progress; auto-promote); **map not prison** |
| Act | Pack tools under task cwd (shell-first) |
| Book | `finding` + evidence when `bookingMode=finding` |
| Continue | Rare recovery: empty-stop budget, booking-gap, small premature budget, optional **goal_continuation** while goal active |
| Session wall | **None** by design; per-tool timeouts remain |
| Settle | Runner emits `task_complete` (natural stop / continue caps / abort) |

---

## 4. Expert packs (catalog + install)

Pack **definitions** are maintained under `experts/<id>/` (`pack.json`, `mission.md`, `work.md`, `skills/`).  
Node **enables** a pack by installing it into the local install root (default `node4/installed-experts/`):

```bash
cd node4 && npx tsx src/expert-cli.ts install ctf
cd node4 && npx tsx src/expert-cli.ts uninstall ctf
```

Empty install set → effective **pentest only** (loaded from catalog).  
Task resolve uses **installed** packs only; engagement/role remain structured fields (**no free-text NLP**).  
Platform **offers** may also gate dispatch (`docs/node-expert-offers.md`).

| Pack | Tools (summary) | Booking |
|------|-----------------|---------|
| `pentest` (default) | todo, shell, fs, http, **session**, **browser**, script, finding, subagent, goal, **skill** (meta) | finding+evidence |
| `ctf` | + captcha; CTF skills under `experts/ctf/skills` | finding+evidence |
| `consult` (stub) | todo, shell, read, goal | none |

Aliases live in each pack’s `pack.json` / `experts/catalog.json`.  
Loader: `node4/src/experts/`. CTF notes: `docs/node4-ctf-role.md`.

---

## 5. Tools (default pentest pack)

| Tool | Role |
|------|------|
| `todo` | Progress map (OMP-class ops; coarse categories) |
| `shell` | High-density bash; scanners via shell when installed |
| `write` / `edit` / `read` | Files under task dir |
| `http` | Single in-scope probe |
| `session` | Multi-step HTTP + per-actor jars (assistive density; not a gate) |
| `browser` | SPA/DOM assist when API recon is insufficient |
| `script` | Optional multi-file helper |
| `finding` | Only product conclusion path when bookingMode=finding |
| `subagent` | Separable work package |
| `goal` | Long-task objective; continuation while active |
| `skill` | Optional load of **meta** methodology (`pentest-web-recon`, `pentest-stuck-rotation`) — not a vuln-class matrix |

**CTF-only assistive:** `captcha` (+ CTF skill set). Do not grow first-class catalogs without lab-driven need.

**Not present:** `finish_scan`, agent-callable terminal status tool, coverage complete hard gates.

---

## 6. Subagent + goals

| Mechanism | Behavior |
|-----------|----------|
| `goal` | Active objective → harness may inject goal_continuation after natural stops (cap via env, e.g. `NODE4_MAX_CONTINUES` / goal continue limits). `complete` may be rejected if evidence audit fails; open goals do not alone invent product findings. |
| `subagent` | Child under `taskDir/subagents/<id>`; evidence written |

---

## 7. Todo session glue

Light coarse map — **one** init with category phases, occasional `done` when a category is exhausted. **Not** one-todo-per-finding. Prefer shell density over bookkeeping.

Open todos **never** block booking or harness settlement.

---

## 8. Booking vs lifecycle

| Concern | Mechanism |
|---------|-----------|
| Evidence | Tool outputs / explicit evidence |
| Confirmed vuln/flag | `finding` only |
| End of session | Harness continue caps / natural stop / abort → `task_complete` |

Typical terminal policy (harness; refine in code carefully):

- `completed` when settlement criteria met (e.g. evidence-backed findings and clean stop)  
- otherwise `incomplete` / failed on abort  

Exact rules live in runner settlement — docs must not invent stricter product gates (no module matrix complete).

---

## 9. Post-run inspectability

| Path | Content |
|------|---------|
| `events.jsonl` | Tool/platform events |
| `findings/`, `evidence/`, `scripts/` | Artifacts |
| `pi-sessions/` | Model session files |
| `agent-summary.json` | Terminal + usage summary |

Offline audit helpers (e.g. `node4` ctf-audit CLI) parse events for engineering — not for injecting answers.

---

## 10. Platform events

| Event | Meaning |
|-------|---------|
| `tool_output` | Act progress |
| `evidence_created` / `vuln_found` | Booking |
| `todo_updated` / `goal_updated` | Map / anchors |
| `status_update` | Harness notes (not agent finish) |
| `task_complete` | **Harness** terminal settlement only |

---

## 11. Legacy runtimes

| Tree | Status |
|------|--------|
| `node4/` | **Product** — maintain |
| `node/`, `node2/`, `node3/` | Reference only; do not expand product features here; planned cleanup |

---

## 12. Non-goals

- oh-my-pi source dependency  
- Full TUI  
- Coverage/phase/finding-gate state machines as the main loop  
- Hardcoded lab answers or expected vuln counts in runtime  
- Exact OMP score parity as a pass bar  
- Agent finish tool  
- Node↔Node P2P mesh (any multi-agent work is **platform-orchestrated**)  
- Multiple commercial Node product lines  
