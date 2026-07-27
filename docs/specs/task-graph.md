# Pentest work modes: Default free OMP + Expert Graph × Pi

> Living companion to `docs/specs/harness.md` §6.  
> Calibrated: 2026-07-27 (Expert Graph-only; phase 2 product `redteam_deep` #78; **NC-Honesty-Advance** map #176)

**Expert Graph:** product-owned runner (`hard-graph-*`); stage order and Feedback are **not** Main OMP scheduling. Soft scenario Graph is **retired** as a product work mode (not Expert DoD).

**Product seats:** **Default** = free platform assistant (never Expert Graph). **Expert** = **Graph mode only** (multi-Graph per expert; product templates `app_assessment` + `redteam_deep`; no Expert free/OMP scene). After Graph `task_complete`, same-session follow-ups stay in the Graph envelope without auto full re-run (C1). Three-layer Task / Agent / Feedback semantics are **product-owned** on Node4 (ADR 0001 B1).

## One sentence

**Default / free OMP** — Main loop schedules itself (Default seat never Expert Graph).  
**Expert Graph × Pi** — outer runner owns stages; pi runs inside stages; fail-closed gates; **Expert pentest DoD**. Product template `app_assessment` resolves here.  
**Soft scenario Graph** — **retired** (historical only; no product UI / no product resolve).  
**Case** holds long-term shared state. Continue-chat / retest stay in the Graph engagement envelope after runner completes (#68).

### Three-layer model → Hard product mapping

| Semantic layer | Node4 Hard product |
|----------------|-------------------|
| **Task Graph** (hard stage order) | Hard Graph runner + pack `graphs/hard/*` (mature `app_assessment` primary; `app_assessment_thin` lab alias) |
| **Agent Graph** (class_probe workers) | Stage captain depth-0 + `subagent` packages when allowed; Join → parent `hard-stage:<stageId>[:<workerId>]` |
| **Feedback Graph** | Stage `require` structure gates + process metrics (discovery yield soft-fail, coverage attempts) on Product state |
| PenState handoff | Parent lifecycle candidates + surface ledger + session jars (A1/A4) |

### Hard Graph stage continuity (A1 + A4)

Per-stage pi sessions still use isolated work dirs (`taskDir/hard-graph/<graphId>/stage-…`) for evidence / optional settlement **audit** artifacts. **Handoff contract (Spec #125):** stage Feedback is **host settlement only** — Finding Store rows, package terminals (host-declared honesty), surface ledger, and package evidence. **Agent-authored `result.json` is ignored** for business gates even if present with `ok: true`. Hard Graph load does **not** require `write` solely for a file handoff (`write` may remain for notes/scripts). Continuity is explicit:

| Concern | Behavior |
|---------|----------|
| **Host stage settlement** | After each stage session, host projects structured outcome for `evaluateStageGate(require)`. Honesty declaration is **host-owned** from package terminals (failed / never_started / aborted / success+salvaged). **Honest partial may pass** (host-declared package fail alone does not block stage/graph). **Silent partial** (`illegal_l2_done` / L2 greened over failed/unfinished packages) and settlement-time **`running`** packages are **stage settlement L0 cannot-advance** (Spec #139 **NC-Honesty-Advance**). Optional `host-settlement-audit.json` is forensics only — not gate input. |
| **Booking / proof (A1)** | Package settlement upserts candidates into **Finding Store** + **book-path L0** (proof + severity); parent lifecycle cache still receives projected candidates for continuity. Main books with `finding(confirm, finding_id=…)` after `feedback_ok`. Serial Main may `finding(upsert)` without packages. Hallucinated proof still fails closed; invent-without-id forbidden on Expert Graph. **Severity (Spec #139 D1 / NC-Severity):** agent assigns critical\|high\|medium\|low\|info; Store preserves; confirm fills from Store when tool omits; **fail-closed** if missing/invalid — **no silent medium**. Package candidates without severity are **rejected at ingest**. Book-path rejects are fixed by **Main → Sub re-dispatch** (package wave) — they do **not alone** raise stage cannot-advance (**NC-Honesty-Advance**). |
| **Session jars (A4)** | Before a stage: seed `parent taskDir/session/` → stage workDir via session-seed helpers. After a stage: promote stage `session/` → parent (best-effort; child cookies win). |
| **Agent Graph** | Hard stage child is **depth 0** with `SubagentHost` when tools allow `subagent` (not nest-banned). Workers nest-ban at depth ≥1. |
| **Process Feedback** | **Exactly two layers (Spec #139 D3 / NC-L1)** plus honesty-advance law (**NC-Honesty-Advance**). **Stage settlement L0:** structure require + package honesty (`illegal_l2_done` / silent partial, settlement `running`) gates **stage pass/advance**. **Book-path L0:** proof, severity, invent-without-id gate **Store/confirm** only. **Boss loop:** stage L0 fail → host **machine brief** injected into next stage attempt via **fixed template** → Main must re-dispatch / abandon+new package / fix L2 declare / close running (same shape as L1 refine, **separate** stage `max_retries` budget from L1 refine). **L1** Critic only after stage L0 passes; cannot bypass L0. If stage L0 still dirty after budget: stage **blocked**, stop later **probe** stages, run **booking-only tail** (`validate_book`-class), Graph may `terminal=blocked`, **mandatory close-out**. Process metrics are **observability/close-out only** — not a third Feedback tier. **No** expected-finding counts. |
| **Finding Store** | Store-first SoT for vuln intelligence (survives stages); package settlement auto-enqueues Feedback; Main `finding(confirm)` only with `finding_id` after `feedback_ok`; confirm ⇒ platform `vuln_found` / ledger. Agent files are never the booking channel. **Graph-start prior seed (D2 / NC-Prior):** host imports Scope open findings as `prior=true` (strip bookable historical proof); inject prior snapshot into Hard Graph stage prompts; dual-use re-verify packages + discovery pathKey∩class avoid (host hard-fail spawn). |
| **Engagement close-out** | On any Graph terminal: dual storage is **taskDir file** (`engagement-closeout.json`) **+** platform timeline message (`type: engagement_closeout`, same JSON semantics) — scope, stages, surfaces, findings by severity, priors, L0/L1 gist, residual risk (Spec #139 **NC-Closeout** + **NC-Honesty-Advance** C1). When honesty mid-graph blocked: include blocked reasons, booking-tail outcome, unbooked `feedback_ok`; residual class **`blocked_with_unbooked_feedback_ok`** when applicable; **forbid** implying full coverage / process-complete success. After D1 honesty block: still run **booking-only tail** before/with close-out (confirm tools only — no new probe work). Dedicated platform ledger/UI for close-out is **optional / not DoD** for this wave. |
| **Destructive RoE** | Default deny destructive classes (DB wipe/reset, bulk delete, DoS, password state-change, priv-elevation attacks) unless engagement `allowDestructive`. **Host gate:** shell tool rejects classified destructive commands when deny; RoE injection still steers agents. Lab may set `allowDestructive` on the task envelope (NC-RoE-Destructive). |
| **Package settlement** | Wave = one package attempt (≤2 attempts/package, not a stage pool). Success = intentional structured settlement into host/Store (optional file artifact names only). Salvage ≠ success. Stage `max_retries` independent — stage retry resets non-success package budgets; successful evidence kept. |
| **UI interrupt** | Cancels the in-flight turn only (≠ package-fail). Captain stage session is parked (not disposed) for continue; no empty-message abort; no auto full-batch replay (Spec #116 / #109). |
| **L2 coverage SoT** | Expert Graph: GraphStore only (todo tool is a facade → merge `setStageTodos` + Graph `plan_tree`). Matching node_ids preserve Graph status/ownership when Todo snapshot is weaker; package-anchored done rows + chips are not wiped by routine `todo.done` / retry init. Progress labels stage blocked when L1 is failed/blocked. Non-Graph: TodoStore. Formal Graph packages must anchor existing L2 `plan_node_id`. |

Handoff snapshot in the stage prompt remains informational; booking authority is Finding Store + groundable observations, not prompt-only tables or result.json. Settlement still does not require N bookings.

### Expert Graph workbench observability (parity with free path)

Hard Graph stages share the **same platform message contracts** free Expert / Default use for the right panel and chat — stages are not tool-bridge-only.

| Contract | Behavior |
|----------|----------|
| **Usage** | Stage sessions record LLM usage; mid-run `checkpoint_update` + terminal `task_complete.llm_usage` / checkpoint feed Status tokens. Run owner: `lifecycle.hardGraphRun` (`plan` + `usage` + `panel` + `stageId`) |
| **Thinking / text** | Progressive `thinking` + `text` streams when the Agent Runtime produces them; stage default thinking level matches free Expert non-chat (medium), not a silent downgrade. Free path + stages share `attachNode4SessionObservability` |
| **Tasks L1/L2** | L1 = fixed Graph stages (runner definition); L2 = stage-local todos nested under the stage. Stage `todo` mutations **merge** under the current stage via `hardGraphRun.plan` — preserve package settlement status/ownership; never replace sibling stages or silently wipe completed package-anchored history |
| **Activity** | Timeline accepts product plan sources (`source=plan`) and Graph stage status changes (same plan nodes Tasks shows) |
| **panel_agents** | Collaboration tree: stage Main + subagent workers when packages run |
| **Subagent lifecycle** | `subagent_started` / `subagent_finished` on the platform sink when packages spawn |
| **Worker chips** | Package-owned L2 todos may carry `agent_id` / `owner_agent_name` for Tasks chips |

Probe-class stages that allow `subagent` **prefer packages** when multi-class work is justified (harness steer, not answer keys / fixed N / hard quotas). **Anti-micro-spawn** for trivial single-URL chores. Expert Graph packages **require `plan_node_id`** (L2 anchor). Serial Main remains allowed if Feedback accepts. Soft product mode stays retired; Default never enters Expert Graph.

## Modes

| Mode | How selected | Behavior |
|------|--------------|----------|
| **Default / free OMP** | No Expert Graph template; **Default seat only** | Pure OMP; Main may self-act; voluntary subagent; **not** Expert DoD |
| **Expert Graph × Pi** | Product templates `app_assessment` / `redteam_deep` (aliases), `graphDiscipline=hard`, or `NODE4_HARD_GRAPH=1`; thin lab ids | Runner drives ordered stages; hard files under `graphs/hard/`; fail-closed Feedback; **Main is not the stage scheduler** |
| **Soft scenario Graph** | **Retired** | No product resolve; soft pack JSON removed |

Product Expert UI selects **only** scenario Graphs (`app_assessment`, `redteam_deep`) — no Expert free chip.  
`redteam_deep` loads `graphs/hard/redteam_deep.json` (assessment fork + `chain`/`postex`/`lateral`; `roe.allow_postex: true`).  
Post-Graph continue-chat: structured `graph_execution=continue` (C1) keeps envelope without full Hard re-run. Product retest is **not** a free OMP `/api/vulnerabilities/{id}/retest` path (removed N1); dig-deeper / finding re-verify is Case chat + Agent intent with optional fields `focus_finding_ids` / `focus_note` on normal `task_assign` (map #81).  

**Wire deprecation (closed):** transitional `retest_finding_ids` / `retestFindingIds` keys were accepted only during the first F1 land; they are **removed**. Clients and agents must send `focus_finding_ids` / `focusFindingIds` (and `focus_note` / `focusNote`) only.  
If a task carries structured Graph intent but no hard Graph resolves, the Node **fail-closes** (`task_error` / failed) — never silent free OMP.

UI: casual work → **Default**. Expert work → explicit Graph template selection.

## Subagent + acceptance loop

```text
Main DISPATCH (goal + success_criteria)
  → Sub EVIDENCE (surfaces[] + candidates[] with proof_excerpt)
  → Main JUDGE (acceptance.ready_to_book | needs_more_evidence | surface_ledger)
       ├─ book finding(confirm) verbatim proof_excerpt
       └─ re-dispatch with gaps (max 2) then deadend
```

- No `command=`: LLM child (preferred for vuln claims).
- `command=`: shell only (weak for Graph claims).
- Main books; child does not. Child proofs inject into parent observations.
- Harness returns assistive `acceptance` on each subagent tool result (not a settlement gate).
- **Verbatim book:** `finding(confirm)` with matching `location` / `candidate_index` auto-uses candidate `proof_excerpt` (anti-paraphrase); proof may be omitted when matched.
- **Graph:** no `command=` shell subagents (lab: `NODE4_GRAPH_ALLOW_COMMAND_SUB=1`). Multi-package candidate cache; pathname-only match; book errors list candidate previews.

## Surface ledger (coverage truth)

- Path: `taskDir/surfaces/ledger.json` (`SurfaceLedgerStore`).
- **surface** packages must return `surfaces[]` (live recon locations). Empty → `package_gaps` / re-dispatch.
- Status: `open` → `in_probe` → `probed` | `booked` | `deadend` | `skipped_roe`.
- Candidate locations mark **probed**; `finding(confirm)` marks **booked**.
- **Graph `todo(done)`** blocked while open/in_probe remain unless `note=deadend|skipped_roe` or path already acted. No bare batch-flip.
- Settlement still does not require empty ledger; honesty is about todo green ≠ coverage.

## Parallel subagent batch (OMP-style, v1)

- Tool `subagent` accepts **flat** one package or **batch** `packages[]` + optional shared `context`.
- Batch runs with `mapWithConcurrencyLimit` — default concurrency **8** (`NODE4_SUBAGENT_CONCURRENCY`, clamp 1–16). Safety ceiling 32 packages (not a quality gate).
- Sync only: soft package failure → `results[i].ok=false`; siblings continue.
- **Path re-dispatch budget:** same pathname ≤ **2** dispatches/task.
- **Session seed + promote:** child jars seed from parent `session/`; after each package, child cookies **promote back to parent** (still useful when Main does not re-login; required under lab hard).
- **Worker keep-alive (OMP-style):** after LLM packages (incl. soft-fail/timeout), idle by **`agent_id`**. Default spawn **cold**. Warm only via `resume_agent_id` + **same-path affinity**. **Release:** active idle TTL (default **420s**), maxIdle LRU (8), maxPackages (4), `subagent(op=release)`, task-end `disposeAll`. List: `op=list`. Disable: `NODE4_SUBAGENT_IDLE=0`.
- **Salvage:** missing intentional structured settlement → candidates from tool-output/facts when possible (**evidence only**; salvage ≠ package success).
- Ledger/post-process mutex-serialized. Main still books.

## Non-goals

- Kill-chain as hard `force_order` state machine  
- Stage-named product experts (Recon/Exploiter/Validator seats)  
- Platform conversation Orchestrator  
- LangGraph / CrewAI as execution kernel  

## Pack files

- Expert Graph: `experts/pentest/graphs/hard/app_assessment.json` (mature primary), `experts/pentest/graphs/hard/redteam_deep.json` (deep + post-ex), `experts/pentest/graphs/hard/app_assessment_thin.json` (lab/compat)
- Soft pack JSON under `graphs/*.json`: **removed** from product tree (#76)

## DVWA three-way lab

```bash
cd node4
# Requires DVWA e.g. http://127.0.0.1:8080
bash scripts/bench-dvwa-work-modes.sh
# Or subset:
MODES="free soft" bash scripts/bench-dvwa-work-modes.sh
python3 scripts/score-dvwa-work-modes.py workspace/bench-dvwa-modes/<stamp>
```

Compare `compare.json`: booked findings, Main act vs subagent call mix.
