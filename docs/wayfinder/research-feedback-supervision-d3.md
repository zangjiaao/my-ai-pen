# Research: Feedback supervision & rework design options (D3)

**Ticket:** GitHub #143 · Part of map #140 · Feeds Spec #139  
**Scope:** design options only — **no product code** in this artifact.  
**Date:** 2026-07-27  

## Executive answer

**Product “Feedback Graph” in this wave** should mean: a **runner-owned, L0-only, Product-state supervision plane** that (1) **fail-closes structure/integrity hard signals** and (2) **turns selected process soft-fails into bounded stage rework** via existing `max_retries` — **without** answer keys, without Runtime-transcript gates, and without an in-wave L1 Critic.

| | |
| --- | --- |
| **Recommended option** | **F5 = F1 + F2, defer F3** |
| **Hard (block / retry-until-budget)** | Structure require, host honesty / silent-partial, Finding Store L0 proof |
| **Soft (retry once if budget remains; then advance with metric)** | Discovery-yield empty monologue on probe-like stages |
| **L1 Critic** | **Deferred** past this wave |
| **Not this wave** | F4 (status quo visibility-only), F3 alone, expected vuln counts, transcript Critic |

**Why F5:** session evidence shows L0 already *detects* empty-probe process failure (`discovery_yield_soft_fail_n=1` on `component`) while the stage still **passes attempts=1** and the run completes — supervision without rework. F1 makes soft signals actionable; F2 keeps host settlement + structure gates as the fail-closed backbone; F3 is ADK-shaped quality judgment that does not unlock the current process gap and risks scope/cost without Product-state Critic contracts.

---

## 1. Question restated

What should product **“Feedback Graph”** mean in this wave so it:

1. actually **supervises quality** and can **request rework**,  
2. remains **fail-closed L0**,  
3. is **free of answer keys**, and  
4. stays **compatible with host-owned stage settlement**?

Constraints from product law (`AGENTS.md`, `CONTEXT.md`, Spec #125 / #116 / #111):

- No expected vulnerability counts / target-specific answer keys.  
- Gate input = **Product state** (Store, package terminals, surface ledger, host projection) — never Runtime transcript as SoT.  
- **Silent partial already forbidden** under host settlement.  
- L1 Critic, if any, must use Product state and **cannot bypass L0**.

---

## 2. Primary-source inventory (as-built)

### 2.1 Three-layer mapping (living docs)

| Semantic layer | Node4 product mapping | Source |
| --- | --- | --- |
| Task Graph | Hard Graph runner + pack `graphs/hard/*` | `docs/specs/task-graph.md` |
| Agent Graph | Stage captain + `subagent` packages | same |
| **Feedback Graph** | Stage `require` structure gates + process metrics (discovery yield soft-fail, coverage attempts) on Product state | same table row |
| Feedback L0 | Mechanical structure + package-outcome honesty | `CONTEXT.md` |
| Feedback L1 | Optional Critic agent; bounded refine; **cannot bypass L0** | `CONTEXT.md` |

`CONTEXT.md` also forbids: “Feedback Graph as pure LLM overseer with no hard baseline” and “field-only Feedback with no refine loop when product wants ADK-like hybrid.”

### 2.2 Process Feedback module — `hard-graph-feedback.ts`

Pure Product-state metrics; **no answer keys**:

| Family | Signal | Hard vs soft today |
| --- | --- | --- |
| Structure | `structure_fail_n` when runner marks `structureFailed` | **Hard path** only when gate fails (see runner) |
| Discovery yield | `evaluateDiscoveryYield` → `discovery_yield_soft_fail_n` + notes | **Soft metric only** (does not fail gate) |
| Surface coverage | `coverage_attempts` / `surface_acted_rate` (R1 terminal) | Observability; not stage-block |
| Fanout | `fanout_packages_n` (real Join count, never invented from candidates) | Observability |
| Findings | `findings_booked_n` absolute Store; `book_outcomes` deltas | Observability / alignment |

**Yield rule (process only):** probe-like stage id (`probe|class_probe|authz|auth_session|component`), rich surfaces (≥3 default), accountable (fanout>0 or `class_probe`), and **zero new candidates and zero deadends** → soft-fail. Explicitly **no expected vuln classes**.

### 2.3 Stage gate + retry — `hard-graph-runner.ts`

`evaluateStageGate(stage, structured)` fail-closes on:

- missing `summaryProvided` when `require.summary`  
- `surfaces_min` / `candidates_min` undershoot  
- `structured.ok === false`  

Runner loop:

- gate **ok** → merge handoff, `accumulateStageFeedback(..., structureFailed: false)`, outcome `passed`  
- gate **fail** → `structureFailed: true`, outcome `failed_attempt` or final `blocked`, up to `max_retries + 1` attempts  
- **Yield soft-fail is never consulted** for pass/fail or retry  

Product graphs set `max_retries: 1` on most stages, `0` on `validate_book` (`experts/pentest/graphs/hard/app_assessment.json`).

### 2.4 Host stage settlement — `host-stage-settlement.ts` + package honesty

Spec #125 projector (sole stage outcome for Expert Graph):

- **Ignores** agent `result.json` even if `ok: true`.  
- Projects candidates from **Finding Store** + stage-scoped evidence cache; surfaces from **ledger**.  
- Host **always declares** package failures (`host_declared_keys`); undeclared failures empty by construction.  
- `structured.ok = false` when running packages remain **or** illegal L2-done on failed/unfinished packages (**silent partial**).  
- Optional `host-settlement-audit.json` is forensics only — **not** gate input.  

Package law (`package-settlement-law.ts`): honest partial OK; silent partial forbidden; package wave ≤2 attempts; stage retry can reset non-success package budgets independently of stage `max_retries`.

### 2.5 Finding Store L0 — `finding-store.ts` `applyMechanicalL0Feedback`

Per-candidate mechanical gate (not stage process quality):

- enqueue → `proof_excerpt` present → `feedback_ok`; else `feedback_reject`  
- `finding(confirm)` hard-requires `feedback_ok` + id (invent-without-id forbidden on Expert Graph)  

This is **finding integrity L0**, orthogonal to stage discovery-yield process soft-fail.

### 2.6 Prior research (not product law)

`docs/wayfinder/research-adk-feedback-graph.md`:

- ADK has **no** product name “Feedback Graph.”  
- Closest pattern: deterministic loop/back-edge + optional **LLM Critic** + hard caps (`max_iterations` / escalate).  
- Offline eval ≠ in-run Feedback Graph.  

Implication for product: name is **ours**; ADK supplies **hybrid control** intuition (hard controller + optional agentic judge), not a mandatory Critic this wave.

---

## 3. Session evidence (gap proof)

**Workspace run:** `node4/workspace/4f499989-68fb-4be3-aab0-7e8b94d04e74/hard-graph/run-result.json`

| Observation | Value |
| --- | --- |
| Terminal | `completed` |
| All stages | `outcome: passed`, **`attempts: 1`** |
| `structure_fail_n` | `0` |
| `discovery_yield_soft_fail_n` | **`1`** |
| Yield note | `discovery_yield: stage=component surfaces=29 fanout=12 but new_candidates=0 and deadends=0` |
| L1 Critic | **none** (no Critic stage / agent in product path) |

Interpretation:

1. L0 **process detection works** — rich surfaces + real fan-out + empty cand/deadend for `component` is correctly soft-failed.  
2. L0 **does not supervise** — stage still green; no rework; run completed.  
3. Captain **prose** on `component` claimed findings, but **host projection** for that stage had zero new candidates/deadends — exactly the “empty monologue / narrative ≠ Product state” risk yield is meant to catch. Host settlement correctly did not launder prose into Store; Feedback then failed to act.  
4. Structure path can retry (runner tests: surface `max_retries=1` → attempts≥2 on structure fail). Soft path has **no analogous loop**.

This is the decisive argument against **F4 (visibility-only)** as the *product* meaning of Feedback Graph for this wave: metrics without rework do not “supervise quality.”

---

## 4. Option evaluation (F1–F5)

### F1 — Actionable soft-fail retry

**Idea:** When `evaluateDiscoveryYield` soft-fails on a completed stage attempt, treat it as a **retryable process failure** while stage attempt budget remains: emit `failed_attempt` (or dedicated `soft_failed_attempt`), re-run stage captain with yield note in handoff/prompt surface from **Product state metrics**, consume one `max_retries` slot. After budget exhausted, **advance** (do not hard-block the run solely for yield) and keep metric + note.

| Pros | Cons |
| --- | --- |
| Closes the session gap (soft-fail becomes rework) | Must not turn soft into de-facto hard without design (token cost) |
| Reuses existing `max_retries` / stageAttempt package-budget reset | Need careful “still empty after retry” advance semantics (honest empty allowed) |
| Still process-only (cand **or** deadend satisfies) | Yield uses stage-local structured projection — must stay host-settlement-backed |
| No answer keys; no Critic | Soft-fail on stages that inherited yield from earlier work must not punish “narrow component” wrongly if cand/deadend count is stage-scoped by design (already is) |

**Compatibility:** Host settlement remains sole projector; soft decision reads the same structured projection the gate already receives. Silent partial stays hard via `structured.ok`.

### F2 — Structure-fail integrity (keep/strengthen hard backbone)

**Idea:** Treat structure + host honesty as non-negotiable L0 hard:

- `require.*` undershoot → retry/block as today  
- `structured.ok === false` (running packages / illegal L2) → hard  
- Host-owned declare; agent result.json never gate SoT  
- Finding Store L0 proof remains on book path  
- Do **not** dilute structure pass with “soft enough narrative”  

| Pros | Cons |
| --- | --- |
| Already largely implemented (#125) | Alone does **not** address empty-probe green stages |
| Fail-closed integrity | Over-expanding `require.candidates_min` would smuggle answer-key pressure — reject that |
| Compatible with package honest partial | — |

**This wave role:** **preserve and document as hard matrix**, fix integrity holes only if Spec #139 finds any (e.g. double-count of `structure_fail_n` on terminal block is metrics hygiene, not supervision).

### F3 — L1 Critic (in-wave)

**Idea:** After L0 pass (and optionally after soft settle), run a bounded Critic agent over **Product state snapshot** (Store rows, package terminals, surface ledger, processMetrics notes) that may demand one refine before advance. Cannot override L0 fail.

| Pros | Cons |
| --- | --- |
| ADK-aligned hybrid (prior research) | **High cost / latency**; Critic can be wrong |
| Qualitative process coaching | Needs contracts: Product-state-only inputs, no transcript SoT, no answer keys, capped iterations |
| Matches `CONTEXT.md` L1 vocabulary | **Does not fix** the already-detected empty yield without also wiring rework (F1) |
| | Spec surface large for this wave; risk of LLM overseer without baseline (CONTEXT _Avoid_) |

**Verdict for this wave:** **Defer.** Land L0 rework first; Critic later as optional pack/graph feature once Product-state Critic I/O is specified.

### F4 — Visibility-only (status quo)

**Idea:** Keep accumulating processMetrics for scorecards / UI; never drive stage retry or block from soft signals.

| Pros | Cons |
| --- | --- |
| Cheap, already shipped | **Fails the ticket question** — does not supervise or request rework |
| Safe from false hard blocks | Session proof of green-empty stages remains |

**Reject as product definition of Feedback Graph for this wave** (may remain as the **observability export** under F5).

### F5 — Hybrid F1 + F2, defer F3 (recommended)

**Idea:** Product Feedback Graph this wave =

1. **F2 hard integrity** (structure + host honesty + Store L0) — fail-closed, retry/block via existing runner.  
2. **F1 actionable soft-fail** — discovery yield (and only explicitly listed process soft signals) request **bounded rework**, then advance with metric if still soft.  
3. **F3 Critic deferred**; F4 metrics retained as the soft-family export.  

Matches ADK hybrid **control plane** (deterministic runner owns loop) without requiring ADK’s LLM Critic in-wave. Satisfies CONTEXT: hard baseline + refine loop, without pure LLM overseer.

---

## 5. Recommended signal matrix (this wave)

### 5.1 Hard signals (L0 integrity)

| Signal | Source of truth | On fail | After budget |
| --- | --- | --- | --- |
| Stage `require` (summary / surfaces_min / candidates_min if set) | Host-projected structured | `failed_attempt` → stage retry | **block** run (`terminal: blocked`) |
| Host settlement `structured.ok === false` (running packages, illegal L2 / silent partial) | Package terminals + Graph L2 | same | **block** |
| Package wave fail / salvage | Package terminals (host declare) | honest partial may still pass stage if require met; failures declared | N/A (package budget separate) |
| Finding L0 missing proof | Finding Store | reject row; confirm forbidden | finding stays non-bookable |

**Rules:**

- Silent partial remains **hard-forbidden** (never “soft”).  
- No expected finding counts; do not add product `candidates_min` floors that encode lab answer keys.  
- Agent Runtime transcript is **never** gate input.

### 5.2 Soft signals (L0 process quality → rework)

| Signal | Predicate (Product state only) | On soft-fail | After budget |
| --- | --- | --- | --- |
| **Discovery yield** | Probe-like stage ∧ surfaces ≥ richMin ∧ (fanout>0 ∨ class_probe) ∧ new_candidates=0 ∧ deadends=0 | Consume stage attempt as **retryable soft fail**; surface `discovery_yield_notes` into next attempt context via runner-owned Product metrics (not transcript scrape) | **Advance** stage; keep `discovery_yield_soft_fail_n` + notes on run metrics |
| Coverage / surface_acted_rate | Ledger-derived | **Observe only** this wave (do not soft-block) | Scorecard / UI |
| Fanout / findings alignment | Join count / Store vs platform | **Observe only** this wave | Alignment red flags offline |

**Soft-fail rework semantics (F1 normative sketch for Spec #139):**

1. Evaluate yield **after** host settlement projection (same structured the gate sees).  
2. If structure gate fails → existing hard path wins (do not dual-count as soft-only).  
3. If structure gate passes **and** yield soft-fails **and** attempts remaining → treat as non-pass for advance: same retry loop as structure fail for **attempt accounting**, but terminal outcome after budget should be **`passed` with soft metric** (process debt), **not** `blocked` solely for yield.  
4. Satisfying yield = **≥1 new candidate or ≥1 deadend** in host projection for that attempt — still no expected N.  
5. Stage retry resets non-success package budgets per existing I0.6; successful package evidence kept.  
6. `validate_book` (`max_retries: 0`) does not enter yield rework (not probe-like in practice; yield regex excludes it).

**Rationale for “advance after soft budget”:** empty honest work can be valid; blocking the entire Expert Graph on zero process yield would pressure agents toward invented candidates (answer-key-adjacent). Rework once is the supervision; permanent block is reserved for **integrity** failures.

### 5.3 Deferred (out of wave)

| Signal | Notes |
| --- | --- |
| L1 Critic pass/fail | Product-state-only critic; max 1 refine; never bypass L0; separate ticket |
| Soft-fail on coverage rate thresholds | Easy to become quota-like; keep observability until F1 yield is proven |
| Transcript / salvage-as-success | Forbidden for gates |

---

## 6. What “Feedback Graph” means this wave (product language)

**Definition (wave-normative for Spec #139):**

> **Feedback Graph** is the Hard Graph runner’s L0 supervision plane over **Product state**: host stage settlement + structure `require` gates (hard), Finding Store mechanical proof (hard on book), and process metrics with **actionable soft rework** for discovery-yield empty monologues (soft). It is **not** a free-form LLM overseer, not offline eval, and not agent-authored `result.json` as SoT.

**In / out:**

| In | Out |
| --- | --- |
| Host settlement projector | Agent result.json as gate |
| Structure require + silent-partial hard fail | Expected vuln counts |
| Yield soft-fail → bounded stage rework | In-wave L1 Critic |
| processMetrics export | Runtime transcript as Feedback input |
| Honest partial advance | Silent partial |

**ADK mapping (non-law):** runner ≈ deterministic Loop/controller; yield rework ≈ back-edge with hard `max_retries`; Critic ≈ deferred L1 pattern.

---

## 7. Compatibility checklist (constraints)

| Constraint | F5 compliance |
| --- | --- |
| Fail-closed L0 | Structure/honesty still hard-block; soft never elevates over hard fail |
| No answer keys | Yield uses zero-cand **and** zero-deadend process emptiness only |
| Host-owned settlement | Soft/hard both read host projection; declare remains host-owned |
| Silent partial forbidden | Unchanged hard path |
| Critic Product-state-only | N/A in-wave; future L1 inherits this rule |
| Package budgets independent | Stage retry reset law unchanged |
| Harness over restriction | Prefer one rework over new late validators / answer floors |

---

## 8. Spec #139 implications (feeds, not implements)

Suggested Spec slices (for later task tickets — **not** done here):

1. **Normative Feedback Graph definition** (section 6 language).  
2. **Signal matrix** (section 5) with hard vs soft terminal semantics.  
3. **Runner contract change sketch:** after gate.ok, if yield soft-fail and attempts left → do not break as passed; re-enter attempt loop; on last attempt soft-fail → pass + metrics.  
4. **Observability:** stage_end may need a process outcome tag (e.g. `passed` vs `passed_with_soft_debt` or errors note list) without breaking platform terminal vocabulary (`completed|blocked|aborted`). Prefer additive fields over renumbering HardGraphTerminal.  
5. **Tests:** unit (feedback.test yield still pure); runner fake executor (yield soft → second attempt); process-quality e2e without lab answer keys.  
6. **Explicit non-goals:** L1 Critic, coverage soft-block thresholds, candidates_min as product default.

---

## 9. Options rejected for this wave (summary)

| Id | Reject reason |
| --- | --- |
| **F1 alone** | Without F2 framing, soft rework can be mistaken as replacing integrity gates |
| **F2 alone** | Does not request rework on proven empty-probe soft-fail |
| **F3** | Cost/scope; does not fix already-detected L0 gap; Critic contracts incomplete |
| **F4** | Visibility ≠ supervision (session evidence) |
| **F5** | **Selected** |

---

## 10. Sources (repo paths)

| Path | Role |
| --- | --- |
| `node4/src/runtime/hard-graph-feedback.ts` (+ `.test.ts`) | Process metrics / discovery yield |
| `node4/src/runtime/hard-graph-runner.ts` (+ `.test.ts`) | `evaluateStageGate`, max_retries loop |
| `node4/src/runtime/host-stage-settlement.ts` | Host projector, silent partial |
| `node4/src/runtime/package-honesty-host.ts` / `package-settlement-law.ts` | Package terminals, honest partial, stage-retry budget reset |
| `node4/src/runtime/finding-store.ts` | Mechanical L0 Feedback |
| `node4/src/runtime/hard-graph-stage-executor.ts` | Host settlement finalize path |
| `experts/pentest/graphs/hard/app_assessment.json` | Stage max_retries / require |
| `CONTEXT.md` | Feedback L0/L1 language |
| `docs/specs/task-graph.md` | Feedback Graph mapping |
| `docs/wayfinder/research-adk-feedback-graph.md` | ADK patterns (non-law) |
| `node4/workspace/4f499989-68fb-4be3-aab0-7e8b94d04e74/hard-graph/run-result.json` | Session: yield soft-fail, all attempts=1, no Critic |

---

## 11. Resolution one-liner

**Recommended option id: F5** — ship Feedback Graph as **L0 hard structure/integrity (F2) + actionable discovery-yield soft rework (F1)**; **defer L1 Critic (F3)**; retain metrics export but reject visibility-only (F4) as the product meaning of supervision.
