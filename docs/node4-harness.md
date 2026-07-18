# Node4 Agent Runtime — OMP-class harness

> **Commercial clean-room design** (no oh-my-pi / OMP source dependency).  
> Calibrated: 2026-07-17  
> **This is the only product Node runtime.** Code lives in `node4/`.  
> **Built-in seat `default`（工作台助手）** ships with every Node (platform data tools + light assist; no finding booking).  
> **Expert packs** live under repo **`experts/`** (catalog); Node **installs** copies into a local install root to enable them.  
> **Lab-only bare** `runtime`: no experts installed and explicit bare resolve — A/B vs packs; **not** the product UI default participant.  
> Product conversation model: [`docs/platform-default-agent-refactor.md`](platform-default-agent-refactor.md) (no platform peer Agent).  
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

Node4 is **not** a coding agent. Built-in **`default`** supplies workspace/ledger assist; **expert** packs supply mission + tool surface (e.g. **pentest**).  
Harness mechanics: high-density act tools (execution packs), empty/premature-stop continue, durable task dirs, light todo map; **chat-only** turns for `default`/no-target do not use execution continue budgets as failure UX.

Interactive **TUI remains deferred**.

---

## 2. Principles

1. **OMP harness, role-specific mission** — keep bash/write/edit/todo/continue density; swap pack prompt/tools, not the runner.
2. **Booking ≠ stop** — `finding`/`evidence` may fire many times and **never** ends the loop.
3. **Chat is not product truth** — vuln/flag/auth only via `finding(confirm)` with grounded `proof` (Case evidence created at booking).
4. **No agent finish tool** — no `finish_scan` / agent terminal status tool. `task_complete` is harness/platform settlement.
5. **Findings alone ≠ job done** — N findings do not force mid-loop completed.
6. **Discovery in-loop** — keep acting while concrete untested hypotheses remain; do not drive the loop from a coverage matrix gate.
7. **Simple is strong** — prefer shell + environment (sandbox browser, scanners via shell) over a large mandatory first-class catalog. Extra tools (session, browser, skill) are **assistive**, not process prisons.
8. **Harness over restriction** — weak behavior → prompt / envelope / assistive tools first; not answer keys, expected vuln counts, or default validators.  
   **Booking trust model (simple):** Finding = user-trustable conclusion. **Evidence is created at booking** from agent `proof` (fragment grounded in recent tool output). Act tools do not flood Case with logs. One strong proof is enough; agent does not hunt opaque `evidence_ids`.
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
| Continue | Rare recovery: empty-stop budget, booking-gap, **breadth premature** (until `NODE4_MAX_PREMATURE_STOPS`, not gated on open todos), optional **goal_continuation** while goal active |
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

Blank / `default` / `consult` engagement → **built-in `default` seat** (always available; not offers-gated).  
Explicit **expert** engagement must match an **installed** pack (else blocked).  
Empty install set → only `default` (+ lab bare if forced). Platform **offers** gate **expert** dispatch (`docs/node-expert-offers.md`).

| Pack / seat | Tools (summary) | Booking |
|-------------|-----------------|---------|
| **`default`** (built-in) | platform data tools + light assist (`todo`/`read`; shell restricted/off in v1) | **none** |
| `pentest` | todo, shell, fs, http, **session**, **browser**, script, finding, subagent, goal, **skill** (meta) | finding+evidence |
| `ctf` | + captcha; CTF skills under `experts/ctf/skills` | finding+evidence |
| `consult` | **alias → `default`** during migration (catalog stub retires as separate product) | none |

Aliases live in each pack’s `pack.json` / `experts/catalog.json`.  
Loader: `node4/src/experts/` + built-in default seat. CTF notes: `docs/node4-ctf-role.md`.  
Platform data tools: see [`platform-default-agent-refactor.md`](platform-default-agent-refactor.md) §5.

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
| `finding` | Only product conclusion path when bookingMode=finding; proof-gated (body/stdout + PoC) |
| `fact` | Process cognition (ports/auth/deadends) under `taskDir/facts/` — **not** product vulns; index inject short |
| `subagent` | Separable work package — **required handoff fields**; nest ban |
| `goal` | Long-task objective; continuation while active |
| `skill` | Progressive load of methodology (`list` short / `load` one body) — **not** a permission ACL |

**CTF-only assistive:** `captcha` (+ CTF skill set). Do not grow first-class catalogs without lab-driven need.

**Not present:** `finish_scan`, agent-callable terminal status tool, coverage complete hard gates.

### Discovery breadth continues

Outer **premature** continues (default up to `NODE4_MAX_PREMATURE_STOPS`, often 3) run when the model stops after tools **without** requiring open todos. Lab evidence: agents mark the todo map complete before finishing recon surfaces; gating continue on open todos caused early `natural_stop` with only “easy” findings booked.

Continue inject text steers: re-check recon/facts for untested surfaces, prefer `scripts/` enumerate+probe, rotate skill on untested class — **no** target answer keys or module scoreboard gates.

### Shell output governance (C3)

| Layer | Behavior |
|-------|----------|
| Capture | Process streams capped while running (`STDOUT_CAP` / `STDERR_CAP`) |
| Model-facing | Soft truncate (~48k combined) with head+tail |
| Archive | When truncated, full text under `taskDir/tool-output/<stamp>-shell-*.txt`; path returned for `read` |

### Permissions vs skills (B2 / E2)

| Owns | What |
|------|------|
| Pack `toolNames` + seat | Which tools exist for this engagement |
| Platform `request_decision` / HITL | High-risk authorize cards (see HITL tiers below) |
| Skills | Methodology only — progressive list/load; **never** grants tools or scope |

### HITL tiers for `request_user_decision` / `request_decision` (B1)

| Tier | Examples | Expectation |
|------|----------|-------------|
| **Read-ish free** | `todo`, `read`, `skill list/load`, platform list vulns/reports, fact list/get | No authorize card by default |
| **Act in scope** | `shell`/`http`/`session`/`browser` against authorized target | Proceed under task RoE; no card per probe |
| **High-risk / handoff** | Start another expert (`kind=handoff`), destructive/out-of-scope proposal, user-visible commit beyond engagement | **One** `request_user_decision` card with full plan; wait Authorize/Cancel |
| **Not implemented** | CyberStrike-style automated `audit_agent` reviewer | Deferred — human cards only |

### Process facts (A2 / A3 / A5)

- Path: `taskDir/facts/<key>.json` via `fact` tool (`upsert` / `list` / `get`).
- Inject: short **index** (key + summary) at session start; full body on demand — do not invent from summaries.
- Write-as-you-go when cognition is confirmed; still book product issues only via `finding(confirm)`.
- **Does not create host IP/domain assets** (PRD: user-created only).

---

## 6. Subagent + goals

| Mechanism | Behavior |
|-----------|----------|
| `goal` | Active objective → harness may inject goal_continuation after natural stops (cap via env, e.g. `NODE4_MAX_CONTINUES` / goal continue limits). `complete` may be rejected if evidence audit fails; open goals do not alone invent product findings. |
| `subagent` | Child under `taskDir/subagents/<id>`; evidence written |

### Subagent handoff contract (A1 / D3)

Required structured fields on every `subagent` tool call (child does **not** inherit parent chat):

| Field | Meaning |
|-------|---------|
| `target` | URL \| IP:Port \| domain+path |
| `scope` | In-scope boundary / constraints |
| `already_done` | Parent progress the child must not re-do equivalently |
| `this_turn_goal` | Single objective for this package |
| `success_criteria` | Evidence shape that means success |

Optional: `assignment` (notes), `command` (bounded shell in child), `goal_id`.

**Nested subagent-from-subagent is disallowed** (`lifecycle.subagentDepth >= 1` rejects). Children return structured evidence to the parent only. Exception would require explicit platform/docs enablement (none by default).

Validation: `node4/src/runtime/subagent-handoff.ts`.

---

## 7. Todo session glue (OMP-aligned)

State machine (`stores/todo.ts`) matches OMP ops: content-keyed tasks, single `in_progress`, auto-promote earliest open on `done`.

| Layer | Owns |
|-------|------|
| **node4 harness** (`todo-harness.ts`) | Mechanics: eager init once, mark done when finished, mid-run reconcile (~12 act tools), stop incomplete reminder, settlement non-blocking |
| **Expert pack** (`experts/*/work.md`) | **Which categories** to map (pentest attack classes vs CTF challenge groups vs bare judgment) |

| Glue | Behavior |
|------|----------|
| Eager init | First turn: force phased `todo(init)` then act in the same turn (role-agnostic) |
| Tool prompt | OMP ops + live map hygiene; **no** hardcoded OWASP/CTF phase lists |
| Mid-run nudge | After ~12 act tools without `todo`, inject gentle reconcile (OMP #3651) |
| Stop reminder | Empty/premature continue with open items lists incomplete todos |
| Settlement | Open todos **never** block booking or harness settlement |

Prefer act density over todo thrash, but **do not** leave finished categories open until end-of-run batch-flip.

---

## 8. Booking vs lifecycle

| Concern | Mechanism |
|---------|-----------|
| Act observations | `recordActObservation` (memory only; anti-hallucination) |
| Case evidence | Created at `finding(confirm)` from agent `proof` via `emitCaseEvidence` |
| Confirmed vuln/flag | `finding(confirm)` only — must **prove** the issue exists |
| End of session | Harness continue caps / natural stop / abort → `task_complete` |

**Book-time proof booking** (`node4/src/tools/finding.ts`):

- Required fields: `title`, `location|url`, `description`, `poc` (steps **and** observed result), **`proof`** (fragment grounded in recent tool output)
- System creates one linked Case evidence row from `proof` — agent does **not** hunt opaque `evidence_ids`
- One strong proof is enough to trust + reproduce; quote claim-specific observation per finding
- Platform stores `proof_excerpts` / folds proof into the vuln description for report UIs
- Multi-expert: next pack reads `case_context` findings + linked proof snippets (not prior taskDir)

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
| `tooling-health.json` | L2 sandbox/PATH/scanner readiness snapshot at task start (**observability only**, never a gate) |

### On-demand delivery reports

When the user asks for a vulnerability/detection report, seats with platform report tools (`default`, pentest pack) may call `platform_list_vulnerabilities` then `platform_create_report` to persist a Case revision. Product UI lists revisions in the top-bar **报告** drawer (multi-report; MD/HTML download). Not a harness gate; not created on every booking.

Offline audit helpers (e.g. `node4` ctf-audit CLI) parse events for engineering — not for injecting answers.

---

## 10. Platform events

| Event | Meaning |
|-------|---------|
| `text` (`stream_id`) | Assistant prose **streamed progressively** (token/coalesced flushes); UI upserts one bubble per stream |
| `tool_output` | Act progress (running → done) |
| `evidence_created` / `vuln_found` | Booking (Case-shared materials + findings) |
| `todo_updated` / `goal_updated` | Map / anchors |
| `status_update` | Harness notes (not agent finish) |
| `work_status` | Node busy/idle for session work indicator |
| `task_complete` | **Harness** terminal settlement only |

Platform broadcasts `text` / `tool_output` to the room **before** DB persist so the chat UI is not blocked on write latency.

### Case-shared evidence (multi-expert)

Same conversation = shared Case. Joining experts receive `task_assign.case_context` with:

| Field | Purpose |
|-------|---------|
| `findings_summary[]` | Conclusions + `evidence_ids` + short `proof_excerpt` |
| `evidence_snippets[]` | Prefer **finding-linked** / `role=proof` rows: id, kind, path_or_url, excerpt |
| `artifact_hints[]` | Path crumbs (not full trees) |

Node `emitEvidence` writes truncated **properties** (`role`, `kind`, `excerpt`, path/url/body/stdout) to the platform so the next expert (e.g. code-audit after a source leak) can continue **without** prior `taskDir`.  
`write` of material files emits `file_artifact` (path + preview). `read` does not book Case evidence.  
Details (shipped behavior in code + `prd.md`); historical plan: `docs/archive/evidence-quality-plan.md`.

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
