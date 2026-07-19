# Node4 Agent Runtime — OMP-class harness

> **Commercial clean-room design** (no oh-my-pi / OMP source dependency).  
> Calibrated: 2026-07-17  
> **This is the only product Node runtime.** Code lives in `node4/`.  
> **Built-in seat `default`（工作台助手）** ships with every Node (platform data tools + light assist; no finding booking).  
> **Expert packs** live under repo **`experts/`** (catalog); Node **installs** copies into a local install root to enable them.  
> **Lab bare** `runtime`: clean OMP-aligned Agent Runtime (no expert pack) — goal auto-continue unbounded while active; optional `token_budget` → budget-limited; no session wall. A/B vs packs; **not** the product UI default participant.  
> Product conversation model: [`docs/platform-default-agent-refactor.md`](platform-default-agent-refactor.md) (no platform peer Agent).  
> Legacy trees (`node/`, `node2/`, `node3/`) are reference-only and will be removed later.  
> **No agent finish tool** — session end is harness/platform only.

Related product specs: `docs/prd.md`, `AGENTS.md`, `docs/node-expert-offers.md`, `docs/node4-ctf-role.md`, `experts/README.md`.

---

## 1. North star

```text
OMP-class loop:  Map(todo) → Act(shell/write/edit/http…) → Book(finding+evidence)*  (in-loop)
Product booking: structured tools only (never chat-only conclusions)
Task end:        platform / user cancel / natural model stop / abort — NOT an agent finish tool
Timing:          task_start → started_at; task_complete → end_time (right-panel Elapsed)
Inspectability:  post-run task dir remains fully queryable
```

Node4 is **not** a coding agent. Built-in **`default`** supplies workspace/ledger assist (intent → chat / ledger / report / expert handoff); **expert** packs supply mission + tool surface (e.g. **pentest**).  
Harness mechanics: high-density act tools (execution packs), durable task dirs, light todo map. **Product default: no outer empty/premature/goal inject** — settle when the model naturally stops after in-loop tool use. Lab may re-enable outer recovery via env (`NODE4_MAX_*`).

Interactive **TUI remains deferred**.

---

## 2. Principles

1. **OMP harness, role-specific mission** — keep bash/write/edit/todo density in-loop; swap pack prompt/tools, not the runner. Outer recovery is lab opt-in, not product workflow.
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
| Start | Task envelope → durable task dir; emit `task_start` + checkpoint `started_at` (panel timer opens) |
| Map | `todo` phases (content-keyed; single in_progress; auto-promote); **map not prison** |
| Act | Pack tools under task cwd (shell-first); multi tool-calls **in-loop** until the model stops |
| Book | `finding` + evidence when `bookingMode=finding` |
| Outer continue | **Product default OFF.** Lab opt-in only: `NODE4_MAX_CONTINUES` / `NODE4_MAX_CONTINUES_DEFAULT`, `NODE4_MAX_EMPTY_STOPS`, `NODE4_MAX_PREMATURE_STOPS`, `NODE4_MAX_GOAL_CONTINUES=unlimited\|N`. Policy pure functions remain in `loop-policy.ts`. |
| Session wall | **None** by design; per-tool timeouts remain |
| Settle | Natural stop → terminal checkpoint `end_time` + `task_complete` (panel timer closes). Abort / user cancel also settle. Execution bursts may attach `attack_surface_candidates` / `next_scope_candidates` (out-of-scope hosts) for UI next-Scope — **no** mid-run asset create. |
| Booking | `finding(confirm)` sends `affected_asset`/`port` (location host or task Scope host) so platform can link ledger assets; path-class soft dedupe merges title-drift rediscoveries. |

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
| **`default`** (built-in) | **platform citizen** (full ledger R/W + report) + light assist; no shell/finding | **none** |
| `pentest` | **citizen read layer** + todo, shell, fs, http, session, browser, script, finding, subagent, goal, skill | finding+evidence |
| `ctf` | **citizen read layer** + captcha + CTF skills | finding+evidence |
| `consult` | **alias → `default`** during migration | none |

**Model B (platform citizen base):** every pack loaded via `experts/load-pack` gets injected read tools (`platform_list_assets`, `platform_get_asset`, `platform_list_vulnerabilities`, `platform_get_vulnerability`, `platform_conversation_snapshot`) + Scope/ledger mission lines (`node4/src/roles/platform-citizen.ts`). Specialists add act tools; they do **not** silently create hosts (Authorize / next-scope / asset page only).

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

### Discovery breadth (in-loop; outer premature is lab-only)

**Product:** breadth is prompt/skill-steered inside the first natural tool loop. Outer **premature** inject is **off** unless `NODE4_MAX_PREMATURE_STOPS` > 0 (lab). When enabled, premature continues do not require open todos (map-complete ≠ surface complete).

Lab inject text steers: re-check recon/facts for untested surfaces, prefer `scripts/` enumerate+probe, rotate skill on untested class — **no** target answer keys or module scoreboard gates.

### Right-panel Elapsed (task hooks)

| Hook | Field |
|------|--------|
| `task_start` / runner entry | `checkpoint.started_at` |
| `task_complete` / settle | `checkpoint.end_time` |

UI Elapsed = that window (local tick while running). Tool-call hooks do **not** restart the timer.

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
| `goal` | Tracks long-task objective + optional `token_budget` for display/telemetry. **Product default:** no outer `goal_continuation` inject (`NODE4_MAX_GOAL_CONTINUES` unset/0). Lab: `NODE4_MAX_GOAL_CONTINUES=unlimited` (or positive cap) re-enables outer inject while active. `complete` is free in code (active \| budget-limited); honesty is prompt-steered. Lab-only hard audit: `NODE4_GOAL_REQUIRE_CLEARANCE=1`. Open goals do not invent product findings. |
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
