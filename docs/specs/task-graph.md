# Pentest work modes: Default free OMP + Expert Graph × Pi

> Living companion to `docs/specs/harness.md` §6.  
> Calibrated: 2026-07-27 (Expert Graph-only; phase 2 product `redteam_deep` #78; **NC-Honesty-Advance** map #176)

**Expert Graph:** product-owned runner (`hard-graph-*`); stage order and Feedback are **not** Main OMP scheduling. Soft scenario Graph is **retired** as a product work mode (not Expert DoD).

**Product seats:** **Default** = free platform assistant (never Expert Graph unless a future pack declares Graph capability). **Expert** = pack persona on a **Participant Session** (`docs/specs/participant-session.md` / Spec #277): default **work mode Free** (UI Graph **不指定**); **Expert Graph × Pi** only after explicit user permission for a **declared** graph id (`app_assessment`, `redteam_deep`, …). Silent Free→Graph on resume is forbidden. After Graph `task_complete`, same-session follow-ups stay in the Graph envelope without auto full re-run (C1); exit Graph **parks** harness and returns Free. Three-layer Task / Agent / Feedback semantics are **product-owned** on Node4 (ADR 0001 B1).

## One sentence

**Default / free OMP** — Main loop schedules itself (Default seat never Expert Graph).  
**Expert Graph × Pi** — outer runner owns stages; pi runs inside stages; fail-closed gates; **Expert pentest DoD**. Product template `app_assessment` resolves here.  
**Soft scenario Graph** — **retired** (historical only; no product UI / no product resolve).  
**Case** holds long-term shared state. Continue-chat / retest stay in the Graph engagement envelope after runner completes (#68).

### Three-layer model → Hard product mapping

| Semantic layer | Node4 Hard product |
|----------------|-------------------|
| **Task Graph** | Hard Graph runner + pack `graphs/hard/*`. **Ordered stage harness** (no `edges`): hard stage order, cannot skip — e.g. frozen `app_assessment`. **Engagement Graph** (Spec [#285](https://github.com/zangjiaao/my-ai-pen/issues/285)): optional declarative `edges` + deterministic host route + hop/back-edge budgets — product `hypothesis_cycle`. Lab thin: `app_assessment_thin`. See `docs/specs/engagement-graph-back-edges.md`. |
| **Agent Graph** (class_probe workers) | Stage captain depth-0 + `subagent` packages when allowed; Join → parent `hard-stage:<stageId>[:<workerId>]` |
| **Feedback Graph** | Stage `require` structure gates + process metrics (discovery yield soft-fail, coverage attempts) on Product state |
| PenState handoff | Parent lifecycle candidates + surface ledger + session jars (A1/A4) |

### Hard Graph stage continuity (A1 + A4)

Per-stage pi sessions still use isolated work dirs (`taskDir/hard-graph/<graphId>/stage-…`) for evidence / optional settlement **audit** artifacts. **Handoff contract (Spec #125):** stage Feedback is **host settlement only** — Finding Store rows, package terminals (host-declared honesty), surface ledger, and package evidence. **Agent-authored `result.json` is ignored** for business gates even if present with `ok: true`. Hard Graph load does **not** require `write` solely for a file handoff (`write` may remain for notes/scripts). Continuity is explicit:

| Concern | Behavior |
|---------|----------|
| **Host stage settlement** | After each stage session, host projects structured outcome for `evaluateStageGate(require)`. Honesty declaration is **host-owned** from package terminals (failed / never_started / aborted / success+salvaged). **Honest partial may pass** (host-declared package fail alone does not block stage/graph). **Silent partial** (`illegal_l2_done` / L2 greened over failed/unfinished packages) and settlement-time **`running`** packages are **stage settlement L0 cannot-advance** (Spec #139 **NC-Honesty-Advance**). Optional `host-settlement-audit.json` is forensics only — not gate input. |
| **Booking / proof (A1)** | Package settlement upserts candidates into **Finding Store** + **book-path L0** (proof + severity); parent lifecycle cache still receives projected candidates for continuity. Main books with `finding(confirm, finding_id=…)` after `feedback_ok`. Serial Main may `finding(upsert)` without packages. Hallucinated proof still fails closed; invent-without-id forbidden on Expert Graph. **Severity (Spec #139 D1 / NC-Severity):** agent assigns critical\|high\|medium\|low\|info; Store preserves; confirm fills from Store when tool omits; **fail-closed** if missing/invalid — **no silent medium**. Package candidates without severity are **rejected at ingest**. Book-path rejects are fixed by **Main → Sub re-dispatch** (package wave) — they do **not alone** raise stage cannot-advance (**NC-Honesty-Advance**). **validate_book completeness (#161):** book stages host-inject confirmable Store `feedback_ok` ids into the stage user prompt; primary duty is `finding(list)` → `finding(confirm, finding_id=…)`. **Hybrid empty-book gate:** if confirmable `feedback_ok` exist at stage start and Store booked delta is 0, stage **cannot pass** (`empty_book_with_confirmable_feedback_ok`); partial book may pass with leftover `unbookable_on_exit`; nothing-to-book (0 feedback_ok) may pass with 0 books. **No** expected finding counts. |
| **Session jars (A4)** | Before a stage: seed `parent taskDir/session/` → stage workDir via session-seed helpers. After a stage: promote stage `session/` → parent (best-effort; child cookies win). |
| **Agent Graph** | Hard stage child is **depth 0** with `SubagentHost` when tools allow `subagent` (not nest-banned). Workers nest-ban at depth ≥1. |
| **Process Feedback** | **Exactly two layers (Spec #139 D3 / NC-L1)** plus honesty-advance law (**NC-Honesty-Advance**). **Stage settlement L0:** structure require + package honesty (`illegal_l2_done` / silent partial, settlement `running`) gates **stage pass/advance**. **Book-path L0:** proof, severity, invent-without-id gate **Store/confirm** only. **Boss loop:** stage L0 fail → host **machine brief** injected into next stage attempt via **fixed template** → Main must re-dispatch / abandon+new package / fix L2 declare / close running (same shape as L1 refine, **separate** stage `max_retries` budget from L1 refine). **L1** Critic only after stage L0 passes; cannot bypass L0. If stage L0 still dirty after budget: stage **blocked**, stop later **probe** stages, run **booking-only tail** (`validate_book`-class), Graph may `terminal=blocked`, **mandatory close-out**. Process metrics are **observability/close-out only** — not a third Feedback tier. **No** expected-finding counts. |
| **Finding Store** | Store-first SoT for vuln intelligence (survives stages); package settlement auto-enqueues Feedback; Main `finding(confirm)` only with `finding_id` after `feedback_ok`; confirm ⇒ platform `vuln_found` / ledger. Agent files are never the booking channel. **Graph-start prior seed (D2 / NC-Prior):** host imports Scope open findings as `prior=true` (strip bookable historical proof); inject prior snapshot into Hard Graph stage prompts; dual-use re-verify packages + discovery pathKey∩class avoid (host hard-fail spawn). |
| **Engagement close-out** | On any Graph terminal: dual storage is **taskDir file** (`hard-graph/engagement-closeout.json`) **+** platform message (`type: engagement_closeout`, same JSON body under `engagement_closeout`) **+** conversation Product state (`context.engagement_closeout`, Spec **#163**). Required fields: scope/target, graphId, terminal, stages[], surfaces, findings (by_severity + booked/unbooked/unbookable lists), priors, feedback gist (L0/L1), residual_risk; honesty residual: `process_complete`, `booking_tail_ran`, `blocked_reasons`, `residual_class` when applicable (**NC-Closeout** + **NC-Honesty-Advance** C1). Not a second booking channel or commercial PDF. Platform exposes close-out via conversation snapshot/state, engagement dashboard, timeline, and Status panel card. |
| **Destructive RoE** | Default deny destructive classes (DB wipe/reset, bulk delete, DoS, password state-change, priv-elevation attacks) unless engagement `allowDestructive`. **Host gate:** shell tool rejects classified destructive commands when deny; RoE injection still steers agents. Lab may set `allowDestructive` on the task envelope (NC-RoE-Destructive). |
| **Package settlement** | Wave = one package attempt (≤2 attempts/package, not a stage pool). Success = intentional structured settlement into host/Store (optional file artifact names only). Salvage ≠ success. Stage `max_retries` independent — stage retry resets non-success package budgets; successful evidence kept. |
| **UI interrupt** | Cancels the in-flight turn only (≠ package-fail). Captain working runtime is **parked** (not disposed) for continue — Free Main and Graph stage captain (Spec [#283](https://github.com/zangjiaao/my-ai-pen/issues/283) I0.9). **#282 = mode continuity** (Graph not Free cold OMP); **I0.9 = working-runtime continuity** (same pi session + todos/history on attach). No empty-message abort; no auto full-batch replay (Spec #116 / #109). Idle / no-active-burst interrupt settles Session (no ghost running). Park miss/TTL/crash → mode-correct reseed, never silent Free demotion when mode was Graph. Steer/padding ≠ interrupt. |
| **L2 coverage SoT** | Expert Graph: GraphStore only (todo tool is a facade → merge `setStageTodos` + Graph `plan_tree`). Matching node_ids preserve Graph status/ownership when Todo snapshot is weaker; package-anchored done rows + chips are not wiped by routine `todo.done` / retry init. Progress labels stage blocked when L1 is failed/blocked. Non-Graph: TodoStore. Formal Graph packages must anchor existing L2 `plan_node_id`. **Stage scope (Spec [#281](https://github.com/zangjiaao/my-ai-pen/issues/281)):** on Graph, Todo is a **current-stage L2 checklist only** — reject whole-engagement multi-phase `todo(init)`; neutralize open running L2 when L1 stage ends so Tasks cannot show dual progress (e.g. init-child running + surface running). **Free Tasks (Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313)):** Free TodoStore checklist is **user progress SoT** — **forbid silent full `todo.init` replace** while a map exists; full replace needs explicit user permission; continue must not wipe to a new 0/N map. Soft completion honesty (open items may remain when offering next_steps if disclosed). Graph merge rules above unchanged. |

Handoff snapshot in the stage prompt remains informational; booking authority is Finding Store + groundable observations, not prompt-only tables or result.json. Book stages additionally receive a **host captain list** of confirmable `feedback_ok` ids. Settlement does not require a fixed N bookings, but **forbids green empty-book** when confirmable rows were available (#161 hybrid gate).

### Expert Graph workbench observability (parity with free path)

Hard Graph stages share the **same platform message contracts** free Expert / Default use for the right panel and chat — stages are not tool-bridge-only.

| Contract | Behavior |
|----------|----------|
| **Usage** | Stage sessions record LLM usage; mid-run `checkpoint_update` + terminal `task_complete.llm_usage` / checkpoint feed Status tokens. Run owner: `lifecycle.hardGraphRun` (`plan` + `usage` + `panel` + `stageId`) |
| **Thinking / text** | Progressive `thinking` + `text` streams when the Agent Runtime produces them; stage default thinking level matches free Expert non-chat (medium), not a silent downgrade. Free path + stages share `attachNode4SessionObservability` |
| **Tasks L1/L2** | L1 = fixed Graph stages (runner definition); L2 = stage-local todos nested under the stage. Stage `todo` mutations **merge** under the current stage via `hardGraphRun.plan` — preserve package settlement status/ownership; never replace sibling stages or silently wipe completed package-anchored history. **Free (no L1 stages):** single checklist SoT under TodoStore — Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313) init/replace policy. |
| **Activity** | Timeline accepts product plan sources (`source=plan`) and Graph stage status changes (same plan nodes Tasks shows) |
| **panel_agents** | Collaboration tree: stage Main + subagent workers when packages run |
| **Subagent lifecycle** | `subagent_started` / `subagent_finished` on the platform sink when packages spawn |
| **Worker chips** | Package-owned L2 todos may carry `agent_id` / `owner_agent_name` for Tasks chips |

Probe-class stages that allow `subagent` **prefer packages** when multi-class work is justified (harness steer, not answer keys / fixed N / hard quotas). **Anti-micro-spawn** for trivial single-URL chores. Expert Graph packages **require `plan_node_id`** (L2 anchor). Serial Main remains allowed if Feedback accepts. Soft product mode stays retired; Default never enters Expert Graph.

## Modes

| Mode | How selected | Behavior |
|------|--------------|----------|
| **Default / free OMP** | No Expert Graph template; **Default seat only** | Pure OMP; Main may self-act; voluntary subagent; **not** Expert DoD |
| **Expert Graph × Pi** | Product templates `app_assessment` / `redteam_deep` / `hypothesis_cycle` (aliases), `graphDiscipline=hard`, or `NODE4_HARD_GRAPH=1`; thin lab ids | Runner drives stages (ordered harness **or** engagement edges when declared); hard files under `graphs/hard/`; fail-closed Feedback; **Main is not the stage scheduler** (whitelist `choice_key` only on Gate nodes) |
| **Soft scenario Graph** | **Retired** | No product resolve; soft pack JSON removed |

Product Expert UI Graph control: **不指定** (= Free) plus declared scenario Graphs (`app_assessment`, `redteam_deep`, …). Mode authority is **per Participant Session**, not Case sticky template alone (`docs/specs/participant-session.md`).  
`redteam_deep` loads `graphs/hard/redteam_deep.json` (assessment fork + `chain`/`postex`/`lateral`; `roe.allow_postex: true`).  
Post-Graph continue-chat: structured `graph_execution=continue` (C1) keeps envelope without auto full Hard re-run — **only after product-settled completed Graph**. Incomplete / interrupted / failed Graph same-mode continue uses `graph_execution=resume` and re-enters Hard Graph path (Spec #282 mode wire); when a parked captain exists, Node **attaches** the next user turn to that runtime (Spec #283 I0.9) instead of cold dispose-and-reseed. Must **not** share the C1 wire synonym that demotes to Free cold OMP. Same-mode fail/interrupt continue preserves Session work mode (#277 / #282) and working runtime when parked (#283). Product retest is **not** a free OMP `/api/vulnerabilities/{id}/retest` path (removed N1); dig-deeper / finding re-verify is Case chat + Agent intent with optional fields `focus_finding_ids` / `focus_note` on normal `task_assign` (map #81).  

**Wire deprecation (closed):** transitional `retest_finding_ids` / `retestFindingIds` keys were accepted only during the first F1 land; they are **removed**. Clients and agents must send `focus_finding_ids` / `focusFindingIds` (and `focus_note` / `focusNote`) only.  
If a task carries structured Graph intent but no hard Graph resolves, the Node **fail-closes** (`task_error` / failed) — never silent free OMP.

UI: **不指定** or no Graph capability → Free under current Expert Session. Explicit Graph selection or permitted Agent proposal → Expert Graph × Pi.

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

## Parallel subagent batch (OMP-style, Spec #302)

- Tool `subagent` accepts **flat** one package or **batch** `packages[]` + optional shared `context`.
- Batch runs with `mapWithConcurrencyLimit` — `NODE4_SUBAGENT_CONCURRENCY` (default **8**, clamp 1–16) is **scheduling only** (queue when full; never reject solely for concurrency).
- **Batch safety ceiling** `MAX_SUBAGENT_BATCH` (**32**): hard error if `packages[]` length exceeds it (DoS rail, not agent thinking limit).
- **Per-task cumulative admitted package budget** default **128** (`NODE4_SUBAGENT_TASK_BUDGET`, max **1024**). Counts packages admitted after validation; exhaustion → clear tool error; already-running/finished work remains honest partial.
- **No hard path-dispatch kill** — same pathname may be dispatched many times; path counts are observability only. Repeat work is Agent judgment + task budget + prior-avoid / honest-partial rules.
- Sync only: soft package failure → `results[i].ok=false`; siblings continue.
- **Nest ban:** children (`subagentDepth >= 1`) cannot spawn further subagents (depth = 1).
- **Session seed + promote:** child jars seed from parent `session/`; after each package, child cookies **promote back to parent** (still useful when Main does not re-login; required under lab hard).
- **Worker keep-alive (OMP-style):** after LLM packages (incl. soft-fail/timeout), idle by **`agent_id`**. Default spawn **cold**. Warm only via `resume_agent_id` + **same-path affinity**. **Release:** active idle TTL (default **420s**), maxIdle LRU (8), maxPackages (4), `subagent(op=release)`, task-end `disposeAll`. List: `op=list`. Disable: `NODE4_SUBAGENT_IDLE=0`.
- **Salvage:** missing intentional structured settlement → candidates from tool-output/facts when possible (**evidence only**; salvage ≠ package success).
- Ledger/post-process mutex-serialized. Main still books.
- Non-normative Grok comparison: `docs/wayfinder/research-grok-build-subagent-limits.md`.

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
