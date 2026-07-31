# Research: Our platform SOT / Graph / hypothesis / evidence model

> Ticket: GitHub **#263** · Map **#261** (Black-cat vs platform — contrast and learnings)  
> Scope: **facts only** about product (Node4 Graph × Pi + platform). No Black-cat comparison judgments.  
> Date: 2026-07-31  
> Primary sources: `CONTEXT.md`, `docs/specs/task-graph.md`, `docs/specs/harness.md`, `docs/prd.md`, `docs/adr/0001-graph-x-pi-product-path.md`; pack graphs / `work.md` / mission; Node4 runtime paths only to confirm shipped contracts.

---

## One-line answer

Product truth for Expert work is **Node4 Product state** (session jars, Hard Graph host settlement, surface ledger, Finding Store, Feedback/settlement inputs) plus the **platform ledger** after `finding(confirm)` — not chat, not Runtime transcripts, not agent-authored `result.json`. Expert execution is **Hard Graph × Pi** (ordered stages, packages/waves, dual-lane L0 + optional L1 boss loop, honest partial). Hypothesis-driven probing is **steered** by stage intent / pack harness (especially `class_probe`+ and `work.md`), not by fixed vuln answer keys.

---

## 1. Product state (SOT) vs Runtime transcript

| Layer | Authority | What lives here |
|-------|-----------|-----------------|
| **Product state (SOT)** | Authoritative domain truth (Node4-owned) | Multi-actor session jars; Hard Graph handoff/continuity (parent lifecycle, surface ledger, structured stage results); findings/booking inputs; Feedback/settlement inputs |
| **Runtime transcript** | Subordinate / ephemeral | Turn-local agent messages inside Agent Runtime; optional Node4 event projection for debug/stream |
| **Platform ledger** | Case-level user-trustable vulns/assets/evidence after booking | Assets (user/Authorize/next-scope ownership), confirmed vulns, Case evidence rows, conversation messages/snapshots |

**Normative statements (docs):**

- `CONTEXT.md` — Product state SOT vs Runtime transcript: transcript is **never** fail-closed gate input; avoid dual cookie stores; Feedback must not parse private Runtime/session formats; salvage handoff from transcript forbidden.
- ADR 0001 §Decision 10 — same split: gates must not parse private Runtime/coding-agent session formats; platform observability via **event bridge** from Runtime events.
- `docs/specs/harness.md` — “Chat is not product truth”; booking only via structured tools; no agent finish tool; session JSONL/memory repos denied as product SOT (ADR 0001 Runtime boundary).
- `docs/specs/task-graph.md` — stage Feedback is **host settlement only**: Finding Store rows, package terminals (host-declared honesty), surface ledger, package evidence. **Agent-authored `result.json` is ignored** for business gates even if present with `ok: true`.

**Shipped shape (code confirm):**

- Finding Store: `node4/src/runtime/finding-store.ts` — Store-first product SoT for vuln intelligence; statuses include `open` → `feedback_pending` / `feedback_ok` / `feedback_reject` → `booked`.
- Host settlement: `node4/src/runtime/host-stage-settlement*` — host projects stage outcome; ignores agent `result.json` for gates (Spec #125).
- Surface ledger: `taskDir/surfaces/ledger.json` via `SurfaceLedgerStore` (`node4/src/stores/surface-ledger.ts`).

---

## 2. Handoff (Case-level): Truth + Next + Delivery; surface ledger; Finding Store; close-out

### 2.1 Case-level Handoff vocabulary (`CONTEXT.md`)

**Handoff** is **cross-run continuity**, distinct from Route and from runner stage/package handoff:

| Piece | Role |
|-------|------|
| **Truth** | Scope/RoE, ledger by reference, structured round outcomes |
| **Next** | Workset **proposed → adopted → done** |
| **Delivery** | Host envelope into each assign: **budgeted projection** of Truth+Next — **not a third SOT** |

Avoid (glossary): prose chat as SOT; Agent self-adopting Next or silent Scope edits; taskDir ferry; dual cookie stores.

**Shipped / documented Delivery-adjacent envelopes (not a full Workset state machine in code under that name):**

- Platform → Node `task_assign` with structured engagement / graph fields and **`case_context`** (findings summary + evidence snippets for multi-expert continuity) — `docs/prd.md`, `docs/specs/harness.md` § multi-expert; Node parse `node4/src/runtime/case-context.ts`.
- Scope ownership remains user/Authorize/next-scope (agents must not silent-create host assets) — `docs/prd.md` §4.1.
- Prior findings at Expert Graph start: host seeds Scope open findings into Finding Store as `prior=true` (historical bookable proof stripped) and injects prior snapshot into stage prompts — `docs/specs/task-graph.md` / harness “Prior re-verify”.

**Note:** The glossary’s **Workset proposed→adopted→done** is the Case-level **Next** concept in `CONTEXT.md`. This research did not find a separate product module literally named “Workset store”; operational Next surfaces today include case_context, todos/L2 plan under Graph, surface ledger statuses, and post-run next-scope candidates (UI multi-select → new task). Facts only — naming alignment is out of ticket.

### 2.2 Surface ledger (coverage truth)

From `docs/specs/task-graph.md` + harness:

| Item | Fact |
|------|------|
| Path | `taskDir/surfaces/ledger.json` |
| Deposit | Package `surfaces[]` and/or `fact(op=surface, location=…)` |
| Status flow | `open` → `in_probe` → `probed` \| `booked` \| `deadend` \| `skipped_roe` |
| Effects | Candidate locations → **probed**; `finding(confirm)` → **booked** |
| Graph honesty | Graph `todo(done)` blocked while open/in_probe remain unless `note=deadend\|skipped_roe` or path already acted |
| Stage gate | e.g. `surfaces_min: 1` on `surface` stage = structure (live recon happened), not class matrix |

### 2.3 Finding Store

From task-graph + `finding-store.ts` + `tools/finding.ts`:

- **Store-first SoT** for vuln intelligence across stages (survives stage workdirs).
- Package settlement **auto-enqueues** candidates; serial Main may `finding(upsert)` without packages.
- **Book-path L0:** proof presence, valid severity, invent-without-id ban → gate **Store ingest / confirm** (reject at ingest; no silent medium).
- Main books with `finding(confirm, finding_id=…)` only after row is **`feedback_ok`**.
- Confirm success emits platform **`vuln_found`** / Case evidence — agent files are never the booking channel.
- Subagents **must not** confirm (or upsert on Expert Graph child path); Main books.

### 2.4 Engagement close-out

On any Hard Graph terminal (`docs/specs/task-graph.md`, `node4/src/runtime/engagement-closeout.ts`):

| Channel | Content |
|---------|---------|
| taskDir file | `hard-graph/engagement-closeout.json` |
| Platform message | `type: engagement_closeout` (same JSON body under `engagement_closeout`) |
| Conversation Product state | `context.engagement_closeout` (Spec #163) |

Required fields (spec): scope/target, graphId, terminal, stages[], surfaces, findings (by_severity + booked/unbooked/unbookable), priors, feedback gist (L0/L1), residual_risk; honesty residual: `process_complete`, `booking_tail_ran`, `blocked_reasons`, `residual_class` when applicable.  
**Not** a second booking channel or commercial PDF. Platform surfaces close-out via snapshot/state, engagement dashboard, timeline, Status card.

When stage L0 honesty stays dirty after budget: later **probe** stages stop; **booking-only tail** (`validate_book`-class) may still run; Graph may end `terminal=blocked`; close-out is **mandatory** and must not imply full coverage. Residual class **`blocked_with_unbooked_feedback_ok`** is observability for operators/scorecards.

---

## 3. Hard Graph: stages, packages/waves, Feedback L0/L1, honest partial, boss loop

### 3.1 Product seats and mode selection (structured only)

| Mode | How selected | Behavior |
|------|--------------|----------|
| **Default / free OMP** | No Expert Graph template; **Default seat only** | Pure OMP; Main may self-act; voluntary subagent; **never** Expert Graph |
| **Expert Graph × Pi** | Product templates `app_assessment` / `redteam_deep` (aliases), `graphDiscipline=hard`, hard graph ids / lab thin, or `NODE4_HARD_GRAPH=1` | Hard Graph runner owns stages; fail-closed Feedback; pi runs **inside** stages; Main is **not** the stage scheduler |
| **Soft scenario Graph** | **Retired** (#68 / #76) | No product resolve |

If structured Graph intent is present but no hard Graph resolves → Node **fail-closes** (never silent free OMP). Intent selection must not be free-text keyword NLP inventing engagement (`AGENTS.md`, PRD).

### 3.2 Three-layer model → Hard product mapping

| Semantic layer | Node4 Hard product |
|----------------|-------------------|
| **Task Graph** | Hard Graph runner + pack `graphs/hard/*` |
| **Agent Graph** | Stage captain depth-0 + `subagent` packages; Join → parent `hard-stage:…` |
| **Feedback Graph** | Stage `require` structure + process metrics on **Product state**; dual-lane L0 + L1 Critic after L0 |

Source: `docs/specs/task-graph.md`, `CONTEXT.md`.

### 3.3 Product graph stages (pentest pack)

**Mature primary** — `experts/pentest/graphs/hard/app_assessment.json`:

| Stage | Intent (field) | Gate gist | Subagent | Booking tools |
|-------|----------------|-----------|----------|---------------|
| `init` | init | summary; no live recon | no | no |
| `surface` | surface | summary + `surfaces_min: 1`; inventory + **bounded smoke**; depth deferred to class_probe+ | no | no `finding` |
| `auth_session` | probe | summary | yes | no finding |
| `class_probe` | probe | summary; hypothesis-driven multi-class; packages when recon justifies; no hard package quota; `plan_node_id` L2 | yes | no finding |
| `authz_logic` | probe | summary; dual-actor | yes | no finding |
| `component` | probe | summary; named component narrow | yes | no finding |
| `validate_book` | book | summary; confirm `feedback_ok` by id; invent-without-id ban; hybrid empty-book gate when confirmable rows existed | no | **finding only** |

**Deep template** — `experts/pentest/graphs/hard/redteam_deep.json`: same spine plus `chain` / `postex` / `lateral`; `roe.allow_postex: true`.  
**Thin lab alias** — `app_assessment_thin.json`: init → surface → class_probe → validate_book (not full Expert DoD primary).

Runner / stage executor: `node4/src/runtime/hard-graph-runner.ts`, `hard-graph-stage-executor.ts`, `hard-graph-definition.ts`.

### 3.4 Packages, waves, batch

From `CONTEXT.md` + task-graph + harness:

| Term | Meaning |
|------|---------|
| **Package** | Unit of Agent Graph work Main assigns to one subagent for a stage objective (often attack-class / coverage item) |
| **Wave** | One package attempt start→terminal; product default **≤2 attempts per package** (not a stage-wide pool) |
| **Batch** | One `packages[]` dispatch; may run several packages in parallel (default concurrency 8); **not** all-or-nothing honesty unit |
| **plan_node_id** | Required on Expert Graph formal packages (L2 anchor); missing → spawn hard-fail |
| **Salvage** | Evidence salvage without intentional structured settlement ≠ package **success** |
| **Subagent handoff fields** | Required: `target`, `scope`, `already_done`, `this_turn_goal`, `success_criteria` (+ Graph: `node_type` / `skill_id` optional; `plan_node_id` required) |

### 3.5 Honest partial

- Stage may **advance** when some packages succeeded and others failed, if successes stay in handoff and failures are **explicit**.
- Host-declared package fail alone does **not** block stage/graph.
- **Silent partial forbidden**: full-green coverage while work failed, including **illegal L2-done** over failed/unfinished packages; settlement-time **`running`** packages are stage settlement L0 cannot-advance.

### 3.6 Feedback L0 / L1 and boss loop

From `CONTEXT.md` Feedback L0/L1 (authoritative glossary) + task-graph:

**L0 — two lanes:**

1. **Stage settlement L0** — structure `require` + package-outcome honesty (`illegal_l2_done` / silent partial, settlement `running`) → gates **stage pass/advance**.
2. **Book-path L0** — proof, severity, invent-without-id → gates **Store ingest / confirm** only; Main re-dispatches Sub to fix evidence; does **not alone** raise stage cannot-advance.

**L1** — Critic over **Product state** only after stage L0 passes; cannot bypass L0. Separate refine budget from stage attempt budget.

**Boss loop (shared shape):** stage Feedback fail (settlement L0 or L1 refine) → control returns to Main with actionable list → Main re-dispatches same package with new instructions **or** abandons and spawns new package under changed strategy — not first-fail engagement death, not soft-warn advance.

**L0-fail brief:** host-authored machine fields only (`illegal_l2_done`, `running_packages`, structure errors, package keys), injected via **fixed template** (not L1 prose).

**After L0 honesty dirty + stage budget exhaust:** stage cannot pass; stop later **probe** stages; run **booking-only tail**; mandatory close-out.

Process metrics (e.g. discovery yield soft-fail on probe-like empty yield) are **observability / soft rework** — not a third Feedback tier; no expected finding counts.

### 3.7 Other stage control facts

- Per-stage pi workdirs under `taskDir/hard-graph/<graphId>/stage-…` for evidence / optional settlement **audit** only.
- Session jars (A4): seed parent → stage before; promote stage → parent after (child cookies win on conflict).
- UI interrupt: cancels **in-flight turn** only; captain working session survives; continue = same logical session (not dispose-and-summary-reseed).
- L2 coverage SoT on Expert Graph: GraphStore (todo tool is facade); non-Graph: TodoStore.
- Destructive RoE: default deny destructive classes unless engagement `allowDestructive`; host shell gate + RoE injection.

---

## 4. Hypothesis / probe discipline (only where docs/code say)

Product does **not** implement a named “Hypothesis Store” object. Hypothesis-driven work is encoded as **mission language, stage success intent, tool profiles, package goals, and proof bars**.

| Source | What it says |
|--------|----------------|
| `experts/pentest/mission.md` | Job is “recon, **hypothesis-driven** exploitation, and evidence-backed booking” |
| `app_assessment.json` `class_probe.success` | “**Hypothesis-driven** multi-class probe with bookable candidates (`proof_excerpt`) or honest deadends…” |
| Stage `intent` fields | `init` / `surface` / `probe` / `book` — tool profiles enforce channel boundaries (surface: no subagent, no finding; validate_book: finding only) |
| `experts/pentest/work.md` | Discovery **in-loop** while concrete **untested hypotheses** remain; stop when hypotheses from **this run’s recon** are exhausted or stuck after rotation; ban fixed module lists / expected vuln counts / answer keys; packages when multi-class recon justifies; anti-micro-spawn; unified proof bar (causality / reproducibility / impact); deadend → rotate |
| Subagent contract | `this_turn_goal` + `success_criteria` force single-objective package framing |
| `docs/specs/harness.md` principle 6 | Discovery in-loop while untested hypotheses remain; do not drive loop from coverage matrix gate |
| `AGENTS.md` | Prefer harness steering: attack-surface discovery → **hypothesis-driven testing** → candidate validation → reporting |
| Skills (examples) | Descriptions require recon-triggered class use (e.g. SQLi/SSRF skill “when recon shows…”); stuck-rotation: scanners only when **hypothesis matches** |
| Stage-intent research (shipped boundaries reflected in graph success text) | `docs/wayfinder/research-stage-intent-boundaries.md`: surface = inventory + **bounded smoke**; class_probe+ = hypothesis-driven multi-class depth; structure gates only; no class quotas |

**Fail-closed on evidence shape, not on which CVE exists:**

- Book requires grounded `proof` (fragment in recent tool output) + PoC steps/result.
- Expert Graph: confirm requires Store `finding_id` after `feedback_ok`.
- Severity enum fail-closed (no silent medium) on Store ingest / confirm (Spec #139 D1).

---

## 5. Evidence & booking path to platform ledger

### 5.1 End-to-end path (Expert Graph)

```text
Recon / probe act tools (shell, http, session, browser, …)
  → observations in Runtime + optional fact / surface ledger deposits
  → candidates:
       package intentional structured settlement  ─┐
       or Main finding(upsert) (serial)            ─┴→ Finding Store
  → book-path L0 (proof + severity + …)
       → feedback_ok | feedback_reject
  → Main finding(confirm, finding_id=…)  [only after feedback_ok]
  → emitCaseEvidence + platform vuln_found
  → platform Case ledger (vuln row + evidence)
  → (optional, user-requested) platform_create_report from ledger
```

**validate_book completeness (#161):** host injects confirmable `feedback_ok` ids into stage prompt; primary duty `finding(list)` → `finding(confirm, finding_id=…)`. Hybrid empty-book: if confirmable rows at stage start and booked delta 0 → stage cannot pass (`empty_book_with_confirmable_feedback_ok`). Nothing-to-book (0 feedback_ok) may pass with 0 books. **No** expected finding counts.

**Free OMP (Default never books findings as Expert Graph Store path):** pentest free path may use legacy confirm with handoff candidates when Store/hardGraphRun gate is off (`tools/finding.ts`); Expert Graph hard-requires Store id. Default **built-in seat** has **no** finding booking tools at all (harness §4).

### 5.2 What is / is not evidence

| Kind | Role |
|------|------|
| Act observations | Memory / anti-hallucination ground for proof fragments — not Case rows by themselves |
| `fact` tool | Process cognition under `taskDir/facts/` — **not** product vulns |
| Case evidence | Created **at booking** from agent `proof` via `emitCaseEvidence` |
| Chat / todo / summary | Not product vuln truth |

### 5.3 Platform side (PRD)

- Platform is ledger SOT for assets/vulns/evidence/messages; **no** peer chat Agent.
- Rediscovery: same asset+path/module → platform merge history (not always new row).
- Multi-expert: next pack reads `case_context` findings + proof snippets, not prior taskDir ferry as SOT.

---

## 6. Default seat vs Expert seat

| Dimension | **Default** (built-in 工作台助手) | **Expert** (installed pack, e.g. pentest) |
|-----------|-----------------------------------|-------------------------------------------|
| Availability | Always on Node; not offers-gated | Requires install + platform offers; structured engagement |
| Tools | Platform citizen full ledger R/W + report assist; **no shell/finding** | Citizen **read** layer + act tools (todo, shell, fs, http, session, browser, script, finding, subagent, goal, skill, …) |
| Booking | **None** | `finding` + evidence when `bookingMode=finding` |
| Expert Hard Graph | **Never** enters | Structured work is **Graph-only** when template/discipline selects Hard Graph (`app_assessment`, `redteam_deep`, …) |
| Free OMP | Default free path is the light workbench / non-Expert DoD | Free OMP without Graph template is allowed for pack tools but **not** Expert DoD; product Expert UI selects Graph templates |
| Runtime | pi Agent Runtime via `runNode4Agent` | Same Runtime **inside** stages when on Hard Graph |
| Cross-seat | May propose handoff via HITL `request_user_decision` (`kind=handoff`); user `@` / selects destination expert | Destination owns execution and booking after handoff |

Sources: `CONTEXT.md` Product seats; `docs/prd.md` §§1–5; `docs/specs/harness.md` §§4–6; `docs/specs/task-graph.md` Modes; ADR 0001 Decisions 1–5.

---

## 7. Source index (absolute under repo)

| Path | Use in this research |
|------|----------------------|
| `/mnt/d/Coding/my-ai-pen/CONTEXT.md` | SOT, Handoff Truth/Next/Delivery, Feedback L0/L1, honest partial, seats |
| `/mnt/d/Coding/my-ai-pen/docs/adr/0001-graph-x-pi-product-path.md` | Product path lock; Product state vs Runtime |
| `/mnt/d/Coding/my-ai-pen/docs/specs/task-graph.md` | Hard Graph continuity, Store, ledger, close-out, modes |
| `/mnt/d/Coding/my-ai-pen/docs/specs/harness.md` | Tools, booking, free vs Graph, subagent contract |
| `/mnt/d/Coding/my-ai-pen/docs/prd.md` | Platform vs Node, seats, ledger ownership |
| `/mnt/d/Coding/my-ai-pen/experts/pentest/graphs/hard/app_assessment.json` | Stage order, intents, tool profiles, class_probe success text |
| `/mnt/d/Coding/my-ai-pen/experts/pentest/graphs/hard/redteam_deep.json` | Deep stages + postex RoE |
| `/mnt/d/Coding/my-ai-pen/experts/pentest/work.md` | Hypothesis in-loop, packages, proof bar, Graph process rules |
| `/mnt/d/Coding/my-ai-pen/experts/pentest/mission.md` | Hypothesis-driven mission line |
| `/mnt/d/Coding/my-ai-pen/node4/src/runtime/finding-store.ts` | Store statuses / SoT |
| `/mnt/d/Coding/my-ai-pen/node4/src/tools/finding.ts` | upsert / list / confirm / invent-without-id |
| `/mnt/d/Coding/my-ai-pen/node4/src/runtime/engagement-closeout.ts` | Close-out dual storage |
| `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-runner.ts` | Stage order, booking-only tail, blocked path |
| `/mnt/d/Coding/my-ai-pen/node4/src/runtime/case-context.ts` | Delivery-adjacent case_context shape |
| `/mnt/d/Coding/my-ai-pen/docs/wayfinder/research-stage-intent-boundaries.md` | Stage intent inventory (surface vs class_probe) |

---

## 8. Explicit non-claims (out of ticket)

- No Black-cat comparison, adopt/reject, or “should we add a blackboard” judgment.
- No product code changes in this resolution.
- Workset **lifecycle storage** beyond glossary + case_context/todos/ledger is not fully enumerated as a single named store in the primary specs above.
