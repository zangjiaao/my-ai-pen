# Code review: `feat/139-pentest-expert-process` (Spec #139)

**Base:** `main` · **HEAD:** `8709ac5` · **Scope:** severity integrity, prior seed dual-use, L0/L1 Feedback, stage intent, destructive RoE, validate_book unbookable, engagement close-out, lab scorecards.

**Reviewer mandate:** strict maintainability / code-judo audit (not rubber-stamp).

---

## Summary

The branch lands the right *product kernels* for Spec #139: a clean severity module, prior seed + strip-proof + path∩class avoid helpers, L1 critic contract, engagement close-out builder, and platform fail-closed severity on `vuln_found`. Those cores are mostly boring and testable. Integration is where the PR weakens: NC-Prior dual-use fields are resolved in code but **not published on the subagent tool schema** (re-verify is effectively uncallable by agents); L1 refine budget is **explicitly discarded** (`void l1MaxStageRefine`) while still counting as “bounded”; `ProcessQualityState` becomes a Spec-#139 grab-bag; destructive RoE is prompt-only despite a host gate helper; and `subagent.ts` / stage-executor keep growing by pasted conditionals instead of extracted seams. Severity fail-closed Node↔platform is consistent and is the best part of the change.

**Verdict: REQUEST CHANGES**

Ship after fixing the schema/integration holes and wiring L1 budget for real (or deleting the dead API). Do not treat “unit tests for pure helpers pass” as proof the product path works end-to-end.

---

## Findings

### 1. NC-Prior dual-use is half-wired: tool schema omits the agent surface

| | |
|---|---|
| **Severity** | **Blocker** |
| **Why it matters** | Spec dual-use requires agents to spawn **re-verify** packages with prior Store ids (and optionally `package_kind` / `class_key`). Without those fields on the tool JSON schema, models cannot reliably pass them; host hard-fail then only works as a *deny* path for discovery collisions, not a *complete* dual-use loop. Code that reads fields the tool never advertises is dead product surface. |
| **Evidence** | `node4/src/tools/subagent.ts`: `ResolvedPackage` and `resolvePackageInput` accept `prior_finding_ids`, `package_kind`, `class_key`, `title` (≈100–105, 523–538), and batch/flat spawn call `checkDiscoveryAvoidCollision` with those fields (≈302–308, 400–406). But `packageItemSchema` (≈108–135) and top-level `parameters` Type.Object (≈158–204) **do not declare** any of those keys. Tool description also never mentions re-verify / prior ids. |
| **Preferred remedy (code-judo)** | Add the four fields once on a shared `packageFields` TypeBox fragment used by flat + `packageItemSchema`. One helper `applyPriorAvoidOnPackage(runtime, pkg)` for inject+gate (delete the duplicated batch/flat blocks). Optionally hard-fail spawn when captain text claims re-verify but ids are empty. Add a contract test: schema properties include `prior_finding_ids` / `package_kind`. |

### 2. L1 “bounded refine” budget is dead code; executor lies about L0

| | |
|---|---|
| **Severity** | **High** |
| **Why it matters** | Spec / docs claim L1 is bounded (`l1MaxStageRefine` / env) and runs only after L0 pass. Implementation always calls `runL1Critic({ l0Passed: true, ... })`, discards the budget with `void l1MaxStageRefine`, and only relies on stage `max_retries` for both structure fail and L1 refine. That conflates L0 and L1 budgets, corrupts `refine_n` accounting, and makes the exported L1 API a fiction. Runner order (structure gate before applying L1) is correct for *advance*, but executor state and env knobs are wrong. |
| **Evidence** | `hard-graph-stage-executor.ts` finalizeStage ≈453–484: always `l0Passed: true`; `void l1MaxStageRefine`; increments `pq.l1ByStage[stage].refine_n` before runner L0 gate. `hard-graph-runner.ts` ≈323–354: applies L1 only when `gate.ok` (good), but has no `l1MaxStageRefine()` check. `l1-critic.ts` exports/tests `l1MaxStageRefine()` as product contract. No L1 integration coverage in `hard-graph-runner.test.ts` / stage-executor tests (grep: none). |
| **Preferred remedy** | **Either** (A) wire budget properly: executor computes `l0Passed = settlement honesty + structured.ok` (or runner passes structure outcome back — cleaner: move L1 *decision application* fully into runner after gate, with `refine_n` and `l1MaxStageRefine` there); **or** (B) delete `l1MaxStageRefine` / env and document “L1 shares stage max_retries” — no half-implemented API. Prefer (A): runner owns Feedback graph; executor only returns Product-state snapshot for critic input. |

### 3. `ProcessQualityState` became a Spec #139 kitchen sink

| | |
|---|---|
| **Severity** | **High** |
| **Why it matters** | Process quality was package honesty + Store + attempt budgets (Spec #116). This PR bolts `priorSeed`, `l1ByStage`, `unbookable`, `engagementCloseout` onto the same object. Shared mutable bag across stages invites optional-field sprawl, partial init (`ensureProcessQuality` does not initialize the new fields), and wrong-layer coupling (close-out is a graph-terminal artifact, not package honesty). |
| **Evidence** | `package-honesty-host.ts` `ProcessQualityState` ≈17–33; `createProcessQualityState` inits `l1ByStage`/`unbookable` but `ensureProcessQuality` ≈50–61 only backfills Store/terminals/attempts. Call sites defensively re-init (`if (!pq.l1ByStage)`, `if (!pq.unbookable)`). `hard-graph-task.ts` stashes `engagementCloseout` on pq. |
| **Preferred remedy** | Split run-scoped state: keep `ProcessQualityState` for honesty/Store/attempts; add `GraphRunState` (or fields on `lifecycle.hardGraphRun`) for `priorSeed`, `l1ByStage`, `unbookable`, `engagementCloseout`. One owner, no grab-bag. Delete local re-init scatter. |

### 4. Destructive RoE is prompt theater, not a host gate

| | |
|---|---|
| **Severity** | **High** |
| **Why it matters** | Spec / `task-graph.md` claim default-deny destructive classes and `skipped_roe` when denied. `assertDestructiveAllowed` exists and is unit-tested, but **no tool path calls it**. Agents can still shell `DROP TABLE` / floods; only prompt text discourages it. That is the classic “hardcoded ban list in prose, enforcement elsewhere” gap. |
| **Evidence** | `engagement-roe.ts` `assertDestructiveAllowed` / `classifyDestructiveAction`. Grep under `node4/src/tools`: **no** uses. Production call sites of `formatRoeInjection` / `resolveEngagementRoe` only: `prompt.ts`, `session-runner.ts`. Stage prompt mentions “record skipped_roe” (`hard-graph-stage-executor.ts` ≈167) without tool enforcement. |
| **Preferred remedy** | Wire `assertDestructiveAllowed` at the real execute boundaries that can wipe/flood (at least `shell` command path; optionally `http` body when classifying). On deny: refuse tool result + optional `surfaceLedger.markSkippedRoe`. If product intentionally ships prompt-only for this wave, document that as incomplete NC-RoE and drop “host gate” language from living docs — do not claim enforcement. |

### 5. Stage-id special cases bolted into busy stage prompts

| | |
|---|---|
| **Severity** | **Medium** |
| **Why it matters** | Stage intent (I5) is product content. Hardcoding `stageId === "surface"` / `"init"` / `"validate_book"` inside `stageSystemPrompt` / finalizeStage grows spaghetti and breaks when graphs rename stages or add templates. Graph JSON already has `success` text — intent should live with the graph definition, not executor branches. |
| **Evidence** | `hard-graph-stage-executor.ts` ≈121–134 (surface/init intent strings); ≈486–497 (`validate_book` unbookable accounting keyed on stage id string). |
| **Preferred remedy** | Optional `stage.intent` / `stage.flags.unbookable_on_exit` on Hard Graph stage def (data-driven). Executor formats `stage.intent` if present; unbookable policy is a stage flag or graph-level “book stage” marker — not `=== "validate_book"`. |

### 6. `subagent.ts` at the 1k cliff with copy-pasted prior-avoid blocks

| | |
|---|---|
| **Severity** | **Medium** |
| **Why it matters** | File is **990 lines** (near the non-negotiable “do not cross 1k without strong reason” line). This PR adds the same prior-avoid inject+hard-fail sequence twice (batch loop + flat path) instead of one helper. Next NC will push it over. |
| **Evidence** | `node4/src/tools/subagent.ts` ends ≈990; blocks ≈294–312 and ≈392–411 are near-duplicates. |
| **Preferred remedy** | Extract `enforcePriorPackagePolicy(runtime, pkg): error | void` in `prior-seed.ts` (or thin subagent helper module). Net line reduction; keep tool file under growth pressure. Same pass as Finding #1 schema fix. |

### 7. Mechanical L1 under-severity is a host keyword table

| | |
|---|---|
| **Severity** | **Medium** |
| **Why it matters** | AGENTS.md / harness rules reject host keyword maps that simulate judgment. `mechanicalProductStateCritic` always-on branch matches title regexes (`rce|command injection|...`) against all-medium severity and forces refine. Yield refine is env-gated; under-severity is not. That is host scoring dressed as Feedback. |
| **Evidence** | `l1-critic.ts` `mechanicalProductStateCritic` ≈74–87; test asserts refine on “Command injection RCE” + all medium (`l1-critic.test.ts` ≈56–66). Research D1 rejected host impact→severity maps; under-severity was “L1 judgment only.” |
| **Preferred remedy** | Keep mechanical critic to honesty flags + optional env-gated yield. Move under-severity to injected LLM critic (or env-opt-in like yield). Do not ship title-keyword severity policy as default product Feedback. |

### 8. Engagement close-out dual storage is Node-complete, platform-passive

| | |
|---|---|
| **Severity** | **Medium** |
| **Why it matters** | Spec NC-Closeout promises taskDir file **and** platform event with same semantics. Node writes file + sends `type: "engagement_closeout"`. Platform has **no** dedicated handler (unlike `vuln_found` / `checkpoint_update`); message is only generic agent save/broadcast. Close-out failures are swallowed (`hard-graph-task.ts` empty catch). Product UI/scorecards may not see structured close-out. |
| **Evidence** | `engagement-closeout.ts` `writeEngagementCloseout`; `hard-graph-task.ts` ≈272–291; platform `router.py` special-cases asset/vuln/evidence/tool_output/checkpoint/plan_tree — no `engagement_closeout`. Grep platform: zero matches. |
| **Preferred remedy** | Either handle/persist structured close-out on platform (conversation task field or typed message), or narrow the living-doc claim to “Node file + timeline message dump.” Never empty-catch without at least process-fact / log. |

### 9. Type boundary debt: casts, optional bags, priorSeed not on StageExecutorInput

| | |
|---|---|
| **Severity** | **Medium** |
| **Why it matters** | Prior injection uses `(input as StageExecutorInput & { priorSeed?: ... })` instead of extending the type. Close-out stores `Record<string, unknown>`. Surface summaries cast through `as`. Pattern will metastasize. |
| **Evidence** | `hard-graph-stage-executor.ts` ≈136, 374; `package-honesty-host.ts` `engagementCloseout?: Record<string, unknown>`; closeout send cast ≈144. |
| **Preferred remedy** | Add optional `priorSeed` to `StageExecutorInput` **or** stop stuffing it into input and only read `ensureProcessQuality(...).priorSeed` in prompt builder (already available — delete the cast path entirely: code-judo). Type close-out as `EngagementCloseout` on graph run state. |

### 10. Severity path is solid; residual gaps are silent drops and free-path redundancy

| | |
|---|---|
| **Severity** | **Medium** (residual; core is good) |
| **Why it matters** | Fail-closed is correctly shared Node↔platform for book path. Package ingest **silently skips** invalid severity (`if (!sev) continue`) — workers get empty join without a machine reason, so captains cannot distinguish “no candidates” from “severity rejected.” Confirm path double-fills severity then re-resolves (harmless but noisy). |
| **Evidence** | `finding-severity.ts` pure module; `finding.ts` upsert require + `resolveBookSeverity` confirm; `finding-store.ts` L0 + assertConfirmAllowed; platform `_normalize_severity` + reject on None (`router.py` ≈150–155, 2190–2202). `ingestPackageCandidatesToStore` ≈444–446 silent continue. |
| **Preferred remedy** | Return rejected-severity ids/reasons from ingest (acceptance gap list) instead of silent drop. Keep resolveBookSeverity as single book gate; remove duplicated `params.severity = gate.record.severity` branches if resolve already prefers store. |

---

## What worked well

- **`finding-severity.ts`** — small, pure, fail-closed, tested. Correct extraction from tool spaghetti.
- **Prior seed strip-proof** — `importPriors` forces `proof_excerpt: undefined`; tests assert it. Dual-use *helpers* (`priorAvoidUnit`, `checkDiscoveryAvoidCollision`, empty_prior injection) are clear and mostly pure.
- **Platform severity** — `_normalize_severity` returns `None` and `vuln_found` errors; matches Node “no silent medium.”
- **Runner L1 application order** — structure gate first; L1 refine cannot clear L0 fail (`hard-graph-runner.ts` ≈323–354). That part of “cannot bypass L0” is real.
- **New modules over mega-file invention** — severity / prior-seed / l1-critic / closeout as separate files is the right shape; problem is incomplete *integration*, not missing files.

---

## Suggested fix order

1. **Schema + single prior policy helper** (Finding #1, #6) — unblocks dual-use; stops 1k cliff growth.
2. **L1 ownership cleanup** (Finding #2) — wire or delete `l1MaxStageRefine`; stop `l0Passed: true` lie; add runner/executor integration test (structure fail ignores L1 pass; L1 refine retries; budget exhaust → blocked).
3. **Split run state** (Finding #3, #9) — prior/L1/closeout off `ProcessQualityState`.
4. **Destructive gate or doc honesty** (Finding #4).
5. **Data-driven stage intent / unbookable** (Finding #5).
6. **Mechanical critic keyword policy** (Finding #7) — opt-in or remove from default.
7. **Platform close-out + non-silent failure** (Finding #8).
8. **Ingest severity rejection feedback** (Finding #10).

Do not land further Feature work on `subagent.ts` / `finding.ts` until (1)+(2) land; they are already at 990 / 940 lines.

---

## Line-count snapshot (product paths)

| File | Approx lines | Note |
|------|--------------|------|
| `node4/src/tools/subagent.ts` | **990** | Near 1k; PR duplicated avoid blocks |
| `node4/src/tools/finding.ts` | **940** | Severity fail-closed added cleanly; still large |
| `node4/src/runtime/hard-graph-stage-executor.ts` | **716** | L1 + validate_book + stage-id intent growth |
| New: `finding-severity.ts` | ~56 | Good |
| New: `prior-seed.ts` | ~202 | Good |
| New: `l1-critic.ts` | ~178 | Contract ok; mechanical keywords weak |
| New: `engagement-closeout.ts` | ~149 | Good builder; platform dual incomplete |

---

*Review artifacts only; no product code changed.*
