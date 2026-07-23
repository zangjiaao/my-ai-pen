# Research: Hard Graph Node4 R1 readiness inventory (post-#57)

**Ticket:** [#63](https://github.com/zangjiaao/my-ai-pen/issues/63)  
**Parent map:** [#59](https://github.com/zangjiaao/my-ai-pen/issues/59) Wayfinder — Hard Node4 parity vs Node5 → delete Node5  
**Related closed fix:** [#57](https://github.com/zangjiaao/my-ai-pen/issues/57) Hard Graph init `result.json` handoff  
**Related task (not this ticket):** [#64](https://github.com/zangjiaao/my-ai-pen/issues/64) achieve R1 Hard thin-path readiness  
**Canonical path:** `docs/wayfinder/hard-graph-r1-readiness-inventory.md`  
**Branch:** `research/hard-graph-r1-readiness-inventory`  
**Date:** 2026-07-24  
**Method:** Code + unit tests + lab stamps on product Node4 core-only Runtime. No product code changes; no new live P1 runs.

**R1 (map #59):** no valid P1 round until Hard thin path can complete **past init** (not `blocked@init`).

---

## Executive answer

| Question | Result |
|----------|--------|
| **R1 readiness (thin path past init)** | **PASS** |
| Init can emit valid `result.json` / structured handoff | **Yes** (code contract + offline tests + live stamp) |
| Thin path can enter surface / class_probe / validate_book | **Yes** (live stamp: all four stages `passed`, `terminal=completed`) |
| Remaining fail-closed footguns? | **Yes** — agent still must write the file; stage gates; thin tool splits; no coverage Feedback (see §2) |
| Ready for valid P1 Juice rounds (map protocol)? | **R1 gate cleared** for process; P1 vs Node5 remains map work (#65), not this inventory |

**Authoritative pre/post lab comparison**

| Stamp | Node SHA | Hard terminal | Stages | Findings |
|-------|----------|---------------|--------|----------|
| `benchmarks/juice-discovery/runs/20260723T190830Z` | `0efb262` (pre-#57) | `blocked` | init only (`structured_ok_false`) | 0 |
| `benchmarks/juice-discovery/runs/20260723T200717Z` | `4337cba` (#57 fix) | `completed` | init → surface → class_probe → validate_book | **8** |

Soft control for dual-arm remains `20260723T190830Z/soft` (6 findings); Soft was not re-run in the second segment.

---

## Sources consulted

| Area | Paths |
|------|--------|
| Thin graph | `experts/pentest/graphs/hard/app_assessment_thin.json` (pack **1.8.2**); installed copy under `node4/installed-experts/pentest/graphs/hard/` |
| Definition / resolve | `node4/src/runtime/hard-graph-definition.ts` |
| Runner + Feedback gates | `node4/src/runtime/hard-graph-runner.ts` (`evaluateStageGate`, `runHardGraph`) |
| Stage executor + disk handoff | `node4/src/runtime/hard-graph-stage-executor.ts` (`loadStageResultJson`, prompts, core-only session) |
| Expert task entry | `node4/src/runtime/hard-graph-task.ts` (`toolNamesForPack` → stage profiles) |
| Continuity A1/A4 | `node4/src/runtime/hard-graph-continuity.ts`, `docs/specs/task-graph.md` |
| Core-only Runtime | `node4/src/runtime/run-node4-agent.ts` (`createBoundNode4Session`) |
| Structured normalize | `node4/src/runtime/subagent-result.ts` |
| Unit tests | `hard-graph-definition.test.ts`, `hard-graph-runner.test.ts`, `hard-graph-stage-executor.test.ts`, `hard-graph-task.test.ts` |
| #57 resolution | Issue comments (write on allowlist; prompt; tests; pack sync) |
| Lab stamps | `benchmarks/juice-discovery/runs/20260723T190830Z/`, `…/20260723T200717Z/` |
| Node5 process contracts (diff only) | `node5/README.md` |
| Prior wayfinder | `docs/wayfinder/hard-soft-juice-arm-invocation.md` |

**Tests re-run this research session (all ok):**

```bash
cd node4
npx tsx src/runtime/hard-graph-definition.test.ts
npx tsx src/runtime/hard-graph-runner.test.ts
npx tsx src/runtime/hard-graph-stage-executor.test.ts
npx tsx src/runtime/hard-graph-task.test.ts
```

---

## 1. R1 checklist

### 1.1 Init → valid `result.json` / structured handoff

| Check | Evidence | Status |
|-------|----------|--------|
| Stage end SOT is workdir `result.json` only | `loadStageResultJson` reads `join(workDir,"result.json")`; missing/invalid → `ok:false`, `deadends:["missing_result_json"]`, summary *missing or invalid result.json* | contract kept (fail-closed) |
| Init allowlist can reach write | thin JSON: `init.tools.allow` includes **`write`** with `todo`/`read`/`fact`/`skill` | fixed by #57 |
| All thin stages with non-empty allow list `write` | same file: surface / class_probe / validate_book also include `write` | yes |
| Load-time reject allow without `write` | `isHardGraphDefinition` / `stageHasResultJsonWritePath`; unit test `bad_no_write` → false | regression-guarded |
| Stage prompts name the path | system/user prompts: use **write** for `result.json` (`ok`, `summary`, arrays); “Facts alone are not the stage handoff” | yes |
| Offline tool path | stage-executor test: `createWriteTool` writes `result.json` → load + `evaluateStageGate(init)` **ok** | pass |
| Live init (post-#57) | stamp `20260723T200717Z` stage-0: `result.json` + `normalized-result.json`; run-result init `outcome=passed`, `attempts=1`, `errors=[]` | pass |
| Pre-#57 contrast | stamp `190830Z`: `terminal=blocked`, init `structured_ok_false`, no later stages | closed root cause class |

**Core-only Runtime:** stage sessions use `createBoundNode4Session` (pi-ai + pi-agent-core). Live meta: `piCodingAgent: false`, packages `@earendil-works/pi-ai` / `pi-agent-core`.

**Handoff into runner Feedback:** executor returns normalized structured result → `evaluateStageGate` (default `require.summary`; `structured.ok === false` → `structured_ok_false`). Gate pass merges into `handoff` and advances.

### 1.2 Enter surface / class_probe / validate_book

Thin stage order (product graph):

```text
init → surface → class_probe → validate_book
```

| Stage | Require (Feedback) | Tools (allow) | Lab stamp 200717Z |
|-------|--------------------|---------------|-------------------|
| **init** | `summary: true` | todo, read, fact, skill, **write** | passed (1 attempt) |
| **surface** | `summary` + **`surfaces_min: 1`** | + shell, http, session, browser, script, write | passed (**2** attempts) |
| **class_probe** | `summary` only | same recon set + write | passed (1) |
| **validate_book** | `summary` only | todo, read, fact, skill, write, **finding** (no http/shell) | passed (1); **8** bookings |

| Check | Evidence | Status |
|-------|----------|--------|
| Runner cannot skip stages | `runHardGraph` sequential; fail → terminal blocked/aborted, no later stages | unit-tested |
| Happy-path all stages | runner test fake executor → `terminal=completed`, order matches graph ids | pass |
| Live full thin path | `hard-graph-run-result.json` `completed_stages`: init, surface, class_probe, validate_book | pass |
| Stage workdirs present | `…/hard-graph/app_assessment_thin/stage-{0..3}-*/result.json` | pass |
| Scoreable bookings | `meta.json` `bookedFindings: 8`, findings under stamp `hard/findings/` | pass |

**R1 definition satisfaction:** Hard thin path completed **past init** on product core-only Runtime after #57. Not “blocked@init.”

### 1.3 What R1 does *not* claim

- P1 scorecard parity vs Node5 (M1) — map #59 / task #65.
- DVWA arm, multi-round protocol freeze (#61), Soft product fate (K4).
- Discovery quality, honesty of init “known architecture” surfaces, or finding-count SLA.
- That every future run will complete (agent can still omit `write` or fail `surfaces_min`).

---

## 2. Known remaining fail-closed footguns

These are **remaining product/process risks**, not a re-open of the #57 structural allowlist bug. Useful backlog input for Hard optimization after first valid gap scorecards.

### 2.1 Tools / allowlists

| Footgun | Detail |
|---------|--------|
| **Agent must still call `write`** | Allowlist + prompt make handoff *reachable*; Feedback still fail-closes if the agent only uses `fact`/`todo`. No transcript salvage on Hard path (unlike soft subagent salvage noted in `task-graph.md`). |
| **Allow ∩ pack tools** | Runner applies `applyHardGraphToolProfile(availableTools, profile)` where `availableTools = toolNamesForPack(pack)`. Definition validates `allow` contains `write`, not that the **pack** exposes `write`. Product pack 1.8.2 does; a stripped pack or test pack without `write` would silently drop it from the stage tool list. |
| **validate_book without recon tools** | Allow is `todo/read/fact/skill/write/finding` only. Lab summary explicitly noted remaining candidates needing HTTP re-probe “not available in this stage.” Intentional book-focused stage; depth gap vs stages that can re-hit the target. |
| **No `subagent` / skill fan-out on thin Hard** | Pack has `subagent`; thin allowlists do not include it. Stage work is single core-only session per stage. |
| **Init has no live recon tools** | By design after #57 (`success`: no live recon on init). Live recon starts at surface. |

### 2.2 Stage contracts / Feedback

| Footgun | Detail |
|---------|--------|
| **`surfaces_min: 1` on surface** | Empty `surfaces[]` → gate error `surfaces_min:…` → retries then **blocked** (runner test covers this). Lab used 2 attempts on surface before pass. |
| **`structured.ok === false` always fails** | Even with summary/surfaces, `ok:false` adds `structured_ok_false`. Invalid JSON path forces ok false. |
| **No `candidates_min` on class_probe / validate_book** | Stages can pass with summary + ok and zero candidates. Thin path does not force yield. |
| **validate_book `max_retries: 0`** | Single attempt; booking failures or missing summary → blocked with no retry. |
| **No coverage Feedback** | No `required_coverage`, coverage ledger, or coverage_probe stage on Node4 Hard. Coverage honesty is Soft ledger / Node5 Feedback territory. |
| **No structure-retry beyond stage max_retries** | Unlike Node5 limited hard retry on unparseable JSON stages, Node4 only uses per-stage `max_retries` (init/surface/class_probe default 1). |

### 2.3 Structured shape / handoff quality

| Footgun | Detail |
|---------|--------|
| **deadends object → `"[object Object]"`** | Live handoff shows multiple deadend strings that are `"[object Object]"` — `asStringList` stringifies non-string list items poorly. Does not block gates today (deadends not required) but pollutes handoff audit. |
| **Surface field normalization is lenient** | Agents write varied shapes (`path`/`endpoint`/`type`); normalizer maps to `{location, kind}` when possible. Odd shapes may drop out of `surfaces[]` and risk `surfaces_min` failure. |
| **Handoff candidate cap** | `mergeHandoff` slices candidates/facts/deadends (e.g. 80). High-volume stages can drop earlier items from the cumulative handoff object (booking authority is still lifecycle A1, not prompt-only tables). |
| **Init honesty risk (process, not R1)** | Live init `result.json` included architecture-ish surfaces before live recon. Fail-closed does not judge provenance; P1 M1 may care. |

### 2.4 Continuity / booking (not R1 blockers; residual risk)

| Footgun | Detail |
|---------|--------|
| **A1 seed + A4 jars** | Continuity seeds candidates/observations into book-capable stages; session seed/promote best-effort. Hallucinated proof still fails closed on `finding(confirm)`. |
| **Book only on validate_book allowlist** | `finding` is only on validate_book in the thin profile — earlier stages cannot book even if they hold strong proof (by design of thin cut). |

### 2.5 Operator / product surface

| Footgun | Detail |
|---------|--------|
| **No platform UI Hard Graph selector** | Hard is structured: `graphDiscipline=hard`, hard graph id / aliases, or `NODE4_HARD_GRAPH=1` (see prior research `hard-soft-juice-arm-invocation.md`). Mis-labeling lab “hard” Main-act strip (`NODE4_GRAPH_MAIN_ACT`) as product Hard Graph remains a protocol trap. |
| **Installed-experts sync** | Fix path synced pack graph under `node4/installed-experts/pentest`. Lab/dev must install/sync pack so Runtime does not run a stale allowlist without `write`. |

---

## 3. Diff vs Node5 process contracts (high level)

Source: `node5/README.md` only (lab / semantic reference; not product kernel). **Not** a reopening of product-path PK (ADR 0001).

| Dimension | Node4 Hard thin (`app_assessment_thin`) | Node5 (ADK three-layer) |
|-----------|----------------------------------------|-------------------------|
| **Role** | Product Graph × Pi on Node4 lineage | Lab / semantic reference; CLI only |
| **Task Graph depth** | 4 stages: init → surface → class_probe → validate_book | Longer hard plan: + prior_reverify, auth_session, coverage_probe, authz_logic, component, finalize, … |
| **Agent Graph** | Single stage session (core-only pi); no skill-worker fan-out on thin allowlists | `class_probe` skill package **fan-out workers** → Join |
| **Feedback** | Runner gates: summary / surfaces_min / candidates_min / `ok` | structure, tool_use, evidence, **coverage**, retry; validate_book evidence threshold; process metrics orthogonal to coverage |
| **Coverage** | No Hard-native coverage loop | `required_coverage` + append-only `coverage_ledger` + coverage_probe; blocked when budget exhausted (not silent skip) |
| **State handoff** | Stage `result.json` + parent lifecycle A1 + session A4 jars | `PenState`: cookies, surfaces, candidates, coverage_ledger, feedback, authz_matrix |
| **Knowledge** | Pack skills / prompts; no Hard-only vuln catalog injection | Main INDEX.md + worker `ref_read vulns/<id>.md` |
| **Browser** | pen-sandbox `browser` on surface/class_probe allow | optional `browser` (`NODE5_BROWSER`); missing → blocked on DOM path |
| **Interface** | Platform + standalone Node | CLI only (`python -m node5 …`) |

**Likely Hard optimization backlog drivers later (post valid P1 gap scorecard — not R1 work):**

1. Coverage-style Feedback / ledger port (or explicit thin-path coverage honesty).
2. Deeper Task Graph (auth_session, authz, component) if scorecard gaps show process holes.
3. class_probe yield / fan-out (Agent Graph) if discovery breadth lags Node5.
4. validate_book tool profile (limited re-probe vs pure book).
5. Structure-retry / deadend serialization polish.
6. Soft scenario disposition remains **K4 fog** — Soft is optional control, not Hard optimization target (map #59).

---

## 4. Lab stamp detail (post-#57)

**Path:** `benchmarks/juice-discovery/runs/20260723T200717Z/`  
**Commit on main (bench stamp):** `e531866` — *bench(juice-discovery): Hard second segment post-#57, 8 findings*  
**Fix under test:** `4337cba` — *fix(hard-graph): make stage result.json handoff tool-reachable*

From stamp `hard/meta.json` and `hard/hard-graph-run-result.json`:

| Field | Value |
|-------|--------|
| Runtime | core-only `runNode4Agent` |
| Graph | `app_assessment_thin` |
| Target | `http://127.0.0.1:3010` (`juice-discovery-hard`) |
| Terminal | `completed` / `hard_graph_completed` |
| Wall clock | ~1016s |
| Stages | all `passed`; surface used 2 attempts |
| Booked findings | 8 |
| Supersedes Hard of | `20260723T190830Z` |
| Checklist gates in README | P0 init handoff **pass**; P1 discovery stages **pass**; P2 scoreable Hard **pass** |

---

## 5. Implications for map #59 / task #64

| Item | Implication |
|------|-------------|
| **R1 (map)** | **Satisfied** by code+tests+live stamp: Hard thin path not limited to blocked@init. |
| **Task #64** | Same evidence set is the natural DoD package for “achieve R1”; this research does not close #64 (separate task ticket). |
| **Valid P1 rounds** | Map may now treat Hard arm as **eligible** for protocol-valid Juice rounds (model/RoE/independence still from grilling #61), not blocked by handoff glue. |
| **Optimization** | First honest Hard-vs-Node5 gap scorecard can drive §3 backlog; do not invent gates to fake parity (AGENTS.md harness-over-restriction). |
| **#57** | Remains the structural fix; this inventory is post-verification, not a new fix. |

---

## 6. Out of scope (explicit)

- Implementing remaining footgun fixes (product work / #64 or later tasks).
- New live P1 Hard vs Node5 runs.
- Scorecard field freeze (#60) or protocol freeze (#61).
- Soft arm re-run or Soft product disposition.
- Node5 deletion (X1 / #67).

---

## 7. Verdict line (for parent / issue close)

**R1: PASS** — After #57, product Node4 Hard Graph thin path on core-only Runtime can produce valid stage `result.json`, pass init Feedback, and complete surface → class_probe → validate_book (lab stamp `20260723T200717Z`, terminal `completed`, 8 findings). Remaining footguns are agent/tool-profile/coverage-depth class, not structural impossible handoff at init.
