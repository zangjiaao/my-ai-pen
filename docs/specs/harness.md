# Agent Runtime harness — OMP-class (node4 candidate detail)

> **Product path:** This file describes the **Node4 lineage** harness (Graph × Pi — **unique** product Node). **Expert Graph** (Hard Graph runner: product assessment templates / `graphDiscipline=hard` / hard graph ids / `NODE4_HARD_GRAPH`) is runner-owned stage order with fail-closed Feedback — see `docs/specs/task-graph.md` and ADR 0001. **Soft scenario graph is retired** as a product work mode (#68 / #76). **Default** free OMP never enters Expert Graph. **Agent Runtime** is **pi-ai + pi-agent-core** via product seam `runNode4Agent` (not pi-coding-agent). Fallback B (elevate Node5) is **retired**; `node5/` is deleted. Platform binds to exactly one Node process per deployment (Node4).  

> **Commercial clean-room design** for the node4 path (no oh-my-pi / OMP source dependency).  
> Calibrated: 2026-07-23  
> **Built-in seat `default`（工作台助手）** ships with every Node (platform data tools + light assist; no finding booking).  
> **Expert packs** live under repo **`experts/`** (catalog); Node **installs** copies into a local install root to enable them.  
> **Lab bare** `runtime`: clean OMP-aligned Agent Runtime (no expert pack) — goal auto-continue unbounded while active; optional `token_budget` → budget-limited; no session wall. A/B vs packs; **not** the product UI default participant.  
> Product conversation model: platform has **no** peer chat Agent; Node `default` + experts (shipped).  
> Legacy trees (`node/`, `node2/`, `node3/`) are plan-delete after gates — do not expand.  
> **No agent finish tool** — session end is harness/platform only.

Related product specs: `docs/prd.md`, `AGENTS.md`, `docs/specs/expert-offers.md`, `docs/specs/ctf-role.md`, `docs/specs/task-graph.md`, `docs/specs/context-window-management.md` (occupancy shrink — persist pass then checkpoint), `experts/README.md`.

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
11. **Lean system prompt (serve the LLM)** — single-source rules: runtime `<work-mode>` / RoE for mode truth; pack `work.md` for act discipline; platform-citizen for ledger/handoff. Do not triple-stack Graph soft, priors, or subagent acceptance into every layer. Prefer progressive skill/refs load over encyclopedia system prompts.

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
| Settle | Natural stop → terminal checkpoint `end_time` + `task_complete` (panel timer closes). Abort / user cancel also settle. Execution bursts may attach `attack_surface_candidates` / `next_scope_candidates` (out-of-scope hosts) for Case Workset projection (OOS hosts as Workset inventory; no composer next-scope banner) — **no** mid-run asset create. Spec **#311**: Free + Hard settle also emit `workset_candidates` → Case Workset (`proposed`); Goal mechanical auto-adopt only host-checkable in-scope `t_surface` (never silent `t_host` / RoE expand; path-only not auto-eligible). After auto-adopt, unfinished adopted/`in_progress` deepen keeps Goal `running` (not always `goal_complete`). Spec **#312**: operator next-step choices are **agent-authored Choice Cards** in Main chat (`kind=next_steps`, multi-select); mechanical WorksetChoiceBar / right-panel Next are **retired**. Case Workset remains inventory SoT + optional option binds; soft gate may inject one prompt retry when settle/continue has open Workset but no legal next_steps card. Goal mechanical auto-adopt and host API remain; optional `workset_item_id` on `user_message` still refreshes baton stamps when present; settle clears the baton. `status=incomplete` is not user-stop. **Grok-aligned Goal outer:** turn cancel (abort/interrupt/Esc) is **not** Case `goal_stopped` — Goal stays `running` for continue; sticky `goal_stopped` reopens when Goal still on (`goal_mode` true); outer round is **not** bumped on turn-cancel. Explicit Goal-off: UI toggle off sends `goal_mode: false` + `user_stopped` (assign or settle) → `goal_stopped`. Goal settle lands Participant Session Free (`return_to: free`, no Graph auto-chain). |
| Booking | `finding(confirm)` sends `affected_asset`/`port` (location host or task Scope host) so platform can link ledger assets; path-class soft dedupe merges title-drift rediscoveries. `location` must include a request path/URL (not payload-only). **Severity (Spec #139 D1):** agent-assigned enum critical\|high\|medium\|low\|info; Store preserves; confirm fills from Store when omitted; **fail-closed** if missing/invalid on Node and platform — **no** `severity \|\| "medium"`. |
| Prior index (Free) / Prior re-verify (Graph) | **Free:** `scope_intel` injects a Scope-port **title+summary index** (not a start-of-turn retest queue). Agent looks up a row when approaching that surface (`platform_list_vulnerabilities` asset_id+port/q or `platform_get_vulnerability`). Ledger presence ≠ skip and ≠ must-finish. **Expert Graph:** host seeds Scope open findings into Finding Store at graph-start (`prior=true`, historical proof stripped). Main may schedule re-verify packages with prior Store ids + this-run fresh proof; discovery packages host-hard-fail on prior pathKey∩class collision. **Citizen** owns short ledger/honest-count rules. |
| Same-module identity | Platform merges by path∩alias + title stem (security level ≠ new row). `/hackable/uploads` aliases `/vulnerabilities/upload`. sqli ≠ sqli_blind. |
| Output language | Node config `agent_language` (registry: `auto` \| `zh-CN` \| `zh-TW` \| `en` \| `ja`) → `task_assign` / steer rebuild `worker_limits.agent_language` → **every** product session system prompt (free OMP, Hard Graph stage, subagent) via shared `formatAgentLanguageInjection` + `prompt-template` `{{ }}`. **Standing-first (#352):** assembled system prompts **start with** English shell `## Standing node policies`, then nested `### Output language (node policy: …)` English body (this wave — no target-language catalog body required). Covers agent-authored narrative including **thinking/reasoning shown in Chat** (same-language surface as chat, not an English-only side channel), todos/plans, tool intent/progress narration, finding ledger fields, stage/package handoff narration, report markdown. Raw tool stdout/stderr/HTTP bodies **not** rewritten. **Soft guarantee only** (S1 prompt assembly — no hard translate/filter of thinking; model may still emit English). Deferred lever if zh-CN spot-check still heavy-English: target-language or bilingual policy body (follow-up, not this wave). **Catalog SoT:** `shared/agent-language-catalog.json` (shipped copies under node4 / platform backend / frontend — CI tests require byte-identical). Extending languages = edit that JSON + re-copy; no per-locale inject branches or session-path rewrites. |

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
Empty install set → only `default` (+ lab bare if forced). Platform **offers** gate **expert** dispatch (`docs/specs/expert-offers.md`).

| Pack / seat | Tools (summary) | Booking |
|-------------|-----------------|---------|
| **`default`** (built-in) | **platform citizen** (full ledger R/W + report) + light assist; no shell/finding | **none** |
| `pentest` | **citizen read layer** + todo, shell, fs, http, session, browser, script, finding, subagent, goal, skill | finding+evidence |
| `ctf` | **citizen read layer** + captcha + CTF skills | finding+evidence |
| `consult` | **alias → `default`** during migration | none |

**Model B (platform citizen base):** every pack loaded via `experts/load-pack` gets injected read tools (`platform_list_assets`, `platform_get_asset`, `platform_list_vulnerabilities`, `platform_get_vulnerability`, `platform_conversation_snapshot`) + Scope/ledger mission lines (`node4/src/roles/platform-citizen.ts`). Specialists add act tools; they do **not** silently create hosts (Authorize / next-scope / asset page only).

Aliases live in each pack’s `pack.json` / `experts/catalog.json`.  
Loader: `node4/src/experts/` + built-in default seat. CTF notes: `docs/specs/ctf-role.md`.  
Platform data tools: see [`Node default + ledger tools (shipped)`](Node default + ledger tools (shipped)) §5.

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
| **High-risk / handoff** | Start another expert (`kind=handoff`), multi-agent transfer, destructive/out-of-scope proposal | **One** `request_user_decision` card with full plan; wait Authorize/Cancel. Preflight: `platform_list_experts` — no pack peer → refuse card. |
| **Not implemented** | CyberStrike-style automated `audit_agent` reviewer | Deferred — human cards only |

### Process facts (A2 / A3 / A5)

- Path: `taskDir/facts/<key>.json` via `fact` tool (`upsert` / `list` / `get`).
- Inject: short **index** (key + summary) at session start; full body on demand — do not invent from summaries.
- Write-as-you-go when cognition is confirmed; still book product issues only via `finding(confirm)`.
- **Does not create host IP/domain assets** (PRD: user-created only).

---

## 6. Subagent + goals + Free/Graph work mode

| Mechanism | Behavior |
|-----------|----------|
| `goal` | Tracks long-task objective + optional `token_budget` for display/telemetry. **Product default:** no outer `goal_continuation` inject (`NODE4_MAX_GOAL_CONTINUES` unset/0). Lab: `NODE4_MAX_GOAL_CONTINUES=unlimited` (or positive cap) re-enables outer inject while active. `complete` is free in code (active \| budget-limited); honesty is prompt-steered. Lab-only hard audit: `NODE4_GOAL_REQUIRE_CLEARANCE=1`. Open goals do not invent product findings. |
| `subagent` | Child under `taskDir/subagents/<id>`; evidence written |
| Work mode | **Free** (Default seat only) vs **Expert Graph** (product `app_assessment` / `redteam_deep` → Hard Graph runner; Soft retired #76; C1 continue-chat after complete) |

### OMP subagent scheduling

Main (current seat session) decides when to spawn — not a separate Coordinator service and not a LangGraph DAG interpreter.

| Path | Behavior |
|------|----------|
| No `command=` | **Homogeneous child LLM session** (same pack act tools: shell/http/session/browser/script/fs/fact/skill/todo). No parent chat. No nested subagent. **No finding booking** (Main books). Child emits **intentional structured settlement** (optional `result.json` / `structured-return.json` artifact) with candidates/surfaces/facts/deadends; host ingests to Finding Store. **Salvage without intentional settlement ≠ package success** (Spec #116 / #125). Graph packages require `plan_node_id`. Worker `todo` is local-only — must **not** emit Case `plan_tree_updated` (would wipe Main/Graph Tasks on the right panel). **Host auto-bind (Spec #301):** on subagent/package **start**, the host binds the Worker chip to a Case todo work item for both **Free Main Todo** and **Hard Graph L2** (`agent_id` / `linked_agent_id` / `owner_agent_name` + `plan_tree_updated`). Priority: explicit `plan_node_id` → reattach same `agent_id` → single unbound work item → fuzzy title/goal → synthetic `pkg-*` with owner still set. Main may pass ids when known; must **not** need a separate “link” tool. |
| `command=` set | Bounded shell probe only (deterministic / smokes). |
| Lab dry | `NODE4_SUBAGENT_DRY=1` skips LLM and writes a dry structured result. |

### Free vs Expert Graph (pentest)

| Mode | Selection (structured only) | Discipline |
|------|----------------------------|------------|
| **Free** (default) | No graph / `free` | Pure OMP — Main may self-act; subagent optional; **not** Expert DoD |
| **Expert Graph** | Product `app_assessment` (and hard aliases / thin lab ids) | Hard Graph runner owns stages; fail-closed Feedback; pi in stages; Main is not stage scheduler |
| **Soft scenario Graph** | **Retired** (#76) | No product resolve; soft pack JSON removed |

Lab Main-act strip (non-product): `NODE4_GRAPH_MAIN_ACT=hard`. UI default = Free. Expert Graph configs: `experts/pentest/graphs/hard/`. Resolve: `resolveHardGraph`.

**Surface ledger:** `taskDir/surfaces/ledger.sqlite` (Node SQLite working store; Graph gates + `surface` tool) — recon `surfaces[]` work queue; Graph `todo(done)` requires act/deadend/skip (see `docs/specs/task-graph.md`). Legacy `ledger.json` migrates once on open.

**Parallel batch (Spec #302 Grok-like limits):** `subagent({ packages: [...] })` — `NODE4_SUBAGENT_CONCURRENCY` (default **8**, clamp 1–16) is **scheduler pool size only**: packages beyond the window **queue**, never `never_started` solely because the pool is full. **No hard path-dispatch kill** — same target URL may fan out many packages; path counts are observability only (Agent judgment + prior-avoid / honest-partial rules still apply). **Per-task cumulative admitted package budget** default **128** (`NODE4_SUBAGENT_TASK_BUDGET`, clamp max **1024**); counts packages admitted after validation; exhaustion → clear tool error (already-running/finished work stays honest partial). **Batch length safety ceiling** `MAX_SUBAGENT_BATCH` (**32**): hard error if `packages[]` exceeds it (abuse rail, not agent thinking limit). **Nest depth = 1** unchanged (Worker cannot spawn subagent). Non-normative comparison: `docs/wayfinder/research-grok-build-subagent-limits.md`. **Session promote/seed** parent↔child. **Worker keep-alive (OMP):** idle by `agent_id` after package (incl. soft-fail); warm with `resume_agent_id` + same-path affinity; **release** via idle TTL (~420s), maxIdle, `op=release`, or task end (`NODE4_SUBAGENT_IDLE_*`). Orthogonal paths cold-fan-out. Missing intentional structured settlement may be salvaged **for evidence only** — does not count as package success. Package attempt budget ≤2 per package (not stage pool; orthogonal to task spawn budget). **Stage Feedback** is host settlement (Store + package terminals + surface ledger); agent `result.json` is **not** gate SoT (Spec #125). Host declares package failures — honest partial may pass; silent partial forbidden. **L0 honesty vs advance / repair / blocked booking-tail:** Spec #139 **NC-Honesty-Advance** and `docs/specs/task-graph.md` (boss loop, separate stage vs L1 budgets, booking-only tail, `blocked_with_unbooked_feedback_ok`). After packages start this stage, Main orchestrates+settles only (no serial erase of package failure). UI interrupt parks captain session (turn cancel); continue is same Case — not dispose+summary reseed.

### Subagent handoff contract (A1 / D3)

Required structured fields on every `subagent` tool call (child does **not** inherit parent chat):

| Field | Meaning |
|-------|---------|
| `target` | URL \| IP:Port \| domain+path |
| `scope` | In-scope boundary / constraints |
| `already_done` | Parent progress the child must not re-do equivalently |
| `this_turn_goal` | Single objective for this package |
| `success_criteria` | Evidence shape that means success |

Optional: `assignment` (notes), `command` (bounded shell in child), `goal_id`, `skill_id`, `node_type` (required in Graph mode).

**Nested subagent-from-subagent is disallowed** (`lifecycle.subagentDepth >= 1` rejects). Children return structured evidence to the parent only. Exception would require explicit platform/docs enablement (none by default).

Validation: `node4/src/runtime/subagent-handoff.ts`. Child session: `node4/src/runtime/subagent-session.ts`.

---

## 7. Todo session glue (OMP-aligned)

State machine (`stores/todo.ts`) matches OMP ops: content-keyed tasks, single `in_progress`, auto-promote earliest open on `done`.

| Layer | Owns |
|-------|------|
| **node4 harness** (`todo-harness.ts`) | Mechanics: eager init once, mark done when finished, mid-run reconcile (~12 act tools), stop incomplete reminder, settlement non-blocking |
| **Expert pack** (`experts/*/work.md`) | **Which categories** to map (pentest attack classes vs CTF challenge groups vs bare judgment) |

| Glue | Behavior |
|------|----------|
| Eager init | System Runtime reminder on **cold Free** (not the user turn): read Case inject and act; `todo(init)` after first live use — coarse categories from recon, not kickoff 确认台账 / 复验. User turn is the operator utterance only (same as park-hit). |
| Tool prompt | OMP ops + live map hygiene; **no** hardcoded OWASP/CTF phase lists |
| Mid-run nudge | After ~12 act tools without `todo`, inject gentle reconcile (OMP #3651) |
| Stop reminder | Empty/premature continue with open items lists incomplete todos |
| Surface NEW untested (soft) | Empty/premature (and other continues) with **NEW untested > 0** (prefer `is_new` + not TESTED; fallback first-touch `seen`): soft reminder + samples (`surface-harness.ts`); **never** blocks settlement (#411 / #407). Profession NEW→TESTED + priors ≠ coverage in pack `work.md` |
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
| `workspace/case-{caseId}/` | Case-shared local inspect: `findings/`, `evidence/`, `surfaces/` (not Product SOT — ledger is platform) |
| `workspace/case-{caseId}/expert-{expertId}/` | Participant Session sandbox (pen-sandbox `/workspace`): scripts, notes, credentials, cookie `session/` |
| `workspace/case-{caseId}/expert-{expertId}/pi-{sessionId}/` | One pi-agent-core instance: `session.jsonl` (assembled system + incremental user/assistant/tool), `events.jsonl`, `facts/`. Park continue reuses this dir; Reset mints a new `sessionId`. Not a gate. |

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
Details (shipped behavior in code + `prd.md`); historical plan: git history.

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
