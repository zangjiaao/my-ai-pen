# Research: Hard vs product-soft arm invocation for dual-arm Juice

**Ticket:** [#50](https://github.com/zangjiaao/my-ai-pen/issues/50)  
**Parent map:** [#46](https://github.com/zangjiaao/my-ai-pen/issues/46) Wayfinder — First live dual-arm Juice discovery proof + offline scorecard  
**Canonical path:** `docs/wayfinder/hard-soft-juice-arm-invocation.md`  
**Branch:** `research/hard-soft-juice-arm-invocation`  
**Date:** 2026-07-24  
**Method:** Primary-source inventory (Node4 + platform + docs + scripts only). **No live Juice run**, no CLI implementation, no scorecard design.

**Map locks used:** Hard Graph thin **primary** first; **product soft / current Node4 soft** control (C1 — not `benchmarks/omp-juice-20260719`); local Juice `http://127.0.0.1:3000`; RoE app_assessment; sequential Hard → soft.

---

## Executive answer

| Arm | What it is today | How an operator actually launches it (lab-practical) | Platform UI? |
|-----|------------------|------------------------------------------------------|--------------|
| **Hard primary** | Expert **Hard Graph × Pi** thin path `app_assessment_thin` | **Standalone Node4** with hard graph id **or** process env `NODE4_HARD_GRAPH=1` + installed `pentest` pack + target/scope | **No** product selector for Hard Graph. UI only free / `app_assessment` / `redteam_deep`. |
| **Product soft control** | Node4 **soft scenario Graph** `app_assessment` (Main may act; OMP + soft graph injection) — **not** historical OMP bench tree | **Standalone** `--graph-id app_assessment` **or** platform UI template「应用评估 (Graph)」+ `@pentest` / expert pick | **Yes** — engagement template `app_assessment`. |

**Critical vocabulary trap:** `node4/scripts/bench-dvwa-work-modes.sh` mode `hard` is **lab Main-act strip** (`graphMainAct=delegate_only` / `NODE4_GRAPH_MAIN_ACT=delegate_only`) on soft `app_assessment`. It is **not** product Hard Graph (`docs/specs/task-graph.md` distinguishes them). Using that script’s “hard” arm as dual-arm primary would **mislabel** the protocol.

---

## Sources consulted

| Area | Paths |
|------|--------|
| Hard resolve / thin graph | `node4/src/runtime/hard-graph-definition.ts`, `experts/pentest/graphs/hard/app_assessment_thin.json` |
| Hard run path | `node4/src/runtime/session-runner.ts` (`resolveHardGraph` → `runHardGraphExpertTask`), `hard-graph-task.ts`, `hard-graph-stage-executor.ts` |
| Soft scenario graph | `node4/src/runtime/pentest-graph.ts`, `experts/pentest/graphs/app_assessment.json` |
| Task envelope | `node4/src/types.ts` (`graphDiscipline`, `graphId`, `engagementTemplate`, `graphMainAct`) |
| Standalone CLI | `node4/src/standalone.ts` |
| Platform WS normalize | `node4/src/main.ts` (`normalizeTask`) |
| Platform UI templates | `platform/frontend/src/lib/experts.ts`, `ConversationPage.tsx` |
| Platform RoE case | `platform/backend/app/services/case_engagement.py`, `ws/router.py` (`task_assign`) |
| RoE mapping | `node4/src/runtime/engagement-roe.ts` |
| Work modes spec | `docs/specs/task-graph.md`, `docs/specs/harness.md`, ADR `docs/adr/0001-graph-x-pi-product-path.md` |
| Lab scripts | `node4/scripts/bench-dvwa-work-modes.sh`, `bench-three-targets.sh` |
| Prior OMP Juice (reference only) | `benchmarks/omp-juice-20260719/PROMPT.md` |
| Pack install | `node4/src/expert-cli.ts`, `node4/src/experts/install.ts`, `experts/pentest/pack.json` |
| Related research | `docs/wayfinder/hard-graph-juice-capability-gaps.md` (branch `research/hard-graph-juice-capability-gaps`) |

---

## 1. Hard primary — Expert Hard Graph thin

### 1.1 How Hard is selected (structured only)

From `resolveHardGraph` (`hard-graph-definition.ts`):

1. Pack must be **pentest** (other packs → `not_hard`).
2. Hard if **any** of:
   - `task.graphDiscipline === "hard"` → default graph id `app_assessment_thin` if no hard id given
   - `task.graphId` / `engagementTemplate` is a **hard alias**: `app_assessment_thin` \| `hard_app_assessment` \| `thin`
   - env `NODE4_HARD_GRAPH` matches `1|true|yes|hard` → default thin if no hard id
3. Soft id alone (`app_assessment`) **without** discipline/env → **not** Hard (explicit test in `hard-graph-definition.test.ts`).
4. Graph file: `{packRoot}/graphs/hard/app_assessment_thin.json` (`discipline: "hard"`).

Session entry (`session-runner.ts`): after pack resolve and parent `ToolRuntime` mkdir, if hard → `runHardGraphExpertTask` and **return** (no soft Main OMP loop).

### 1.2 Practical launch (recommended for dual-arm lab)

**Prereqs (both arms):**

```bash
cd node4
# model keys via node4/.env or env (PI_MODEL_PROVIDER / PI_MODEL / provider API keys)
npx tsx src/expert-cli.ts install pentest
# Juice reachable at http://127.0.0.1:3000 (lab readiness is separate ticket)
```

**Option A — explicit hard graph id (preferred; task-scoped):**

```bash
cd node4
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="${NODE4_WORKSPACE:-$PWD/workspace}/juice-dual/$STAMP"
mkdir -p "$OUT"

# instruction file: authorized local lab only — do NOT paste Juice challenge keys
# Target + scope must be non-empty or task becomes chat-only (no Hard run).

npx tsx src/standalone.ts \
  --task-id "juice-hard-${STAMP}" \
  --engagement pentest \
  --graph-id app_assessment_thin \
  --target "http://127.0.0.1:3000" \
  --scope "127.0.0.1,localhost,host.docker.internal" \
  --instruction-file "$OUT/instruction-juice.txt" \
  --output "$OUT"
```

`standalone.ts` maps `--graph-id app_assessment_thin` → `task.graphId` + `engagementTemplate` (not free). Hard aliases resolve without needing `--graph-discipline` (CLI does **not** expose `graphDiscipline` today).

**Option B — process env force thin:**

```bash
NODE4_HARD_GRAPH=1 npx tsx src/standalone.ts \
  --task-id "juice-hard-${STAMP}" \
  --engagement pentest \
  --target "http://127.0.0.1:3000" \
  --scope "127.0.0.1,localhost,host.docker.internal" \
  --instruction-file "$OUT/instruction-juice.txt" \
  --output "$OUT"
```

**Footgun:** `NODE4_HARD_GRAPH=1` is **process-wide**. Do **not** leave it set when launching the soft control arm on the same shell/node process.

### 1.3 Platform / product UI path for Hard

| Channel | Hard Graph support today |
|---------|---------------------------|
| UI engagement templates | `free` \| `app_assessment` \| `redteam_deep` only (`experts.ts`) — **no** `app_assessment_thin` / `graphDiscipline` |
| `task_assign` → Node | Case/UI pass `engagement` + `engagement_template` + `allow_postex` (`case_engagement.py`, `router.py`). **No** first-class `graph_discipline` product field observed. |
| `main.ts` `normalizeTask` | Parses `graph_id` / `graphId`, `engagement_template`, `graph_main_act` — **does not** map `graphDiscipline` / `graph_discipline` into `TaskEnvelope` |
| Env on platform-bound Node | `NODE4_HARD_GRAPH=1` on the Node4 process **would** force Hard for **all** pentest work bursts on that process — unsafe for dual-arm if soft runs on same Node |

**Operational conclusion for map #46:** Hard primary should be launched via **standalone** (or an explicit `graph_id=app_assessment_thin` WS payload if hand-crafted). Product UI is **not** an equal Hard launcher today. Missing CLI flag for `graphDiscipline` is a gap (out of ticket to implement).

### 1.4 Pack, scope, target, RoE for local Juice

| Field | Hard primary value |
|-------|--------------------|
| Pack | **`pentest`** installed (`expert-cli install pentest`); Hard never on default/ctf |
| Graph | `app_assessment_thin` (thin stages: init → surface → class_probe → validate_book) |
| Target | `http://127.0.0.1:3000` (`standalone` → `{ type: "url", value }`) |
| Scope allow | at least `127.0.0.1`, `localhost` (add `host.docker.internal` if sandbox needs it — matches DVWA bench) |
| RoE | Thin JSON `roe.allow_postex: false`. Envelope RoE via `resolveEngagementRoe`: unknown template string falls back to **post-ex off** (conservative). Prefer **not** setting `redteam_deep`. Explicit `allowPostex: false` if platform path used. |
| Engagement template string | With `--graph-id app_assessment_thin`, template string is the hard id (not product UI `app_assessment`); bans still conservative. Soft arm should still use product `app_assessment` RoE for map L1. |

### 1.5 What Hard **does not** use

- Soft `default_plan` / node menu from `app_assessment.json`
- Main OMP outer loop scheduling stages
- Stage tool allowlists omit **`subagent`** on every thin stage; `validate_book` has **finding** but no act tools (`app_assessment_thin.json`)

---

## 2. Product soft control — current Node4 soft path

### 2.1 What “product soft” means (C1)

| Mode | Selection | Behavior |
|------|-----------|----------|
| **Soft scenario Graph (control)** | `graphId` / `engagementTemplate` = `app_assessment` **without** Hard resolve | Soft graph injection + RoE; **Main may act** (`delegate_preferred` product default); subagent by `node_type`; **not** Hard Graph DoD |
| Free OMP | no graph / `free` | Pure OMP; still soft-class, but **not** the map’s named soft control if UI “应用评估” is the product soft story |
| Lab Main-act strip | `graphMainAct=delegate_only` or `NODE4_GRAPH_MAIN_ACT=hard` | Soft graph still; Main act tools stripped — **not** product Hard Graph |

Do **not** claim `benchmarks/omp-juice-20260719` as the soft arm (engineering / historical OMP reference only).

### 2.2 Practical launch — standalone (parity with Hard)

```bash
cd node4
# Ensure NODE4_HARD_GRAPH is unset
unset NODE4_HARD_GRAPH
# Ensure lab Main-act strip is not forcing delegate_only
unset NODE4_GRAPH_MAIN_ACT

STAMP=$(date +%Y%m%d-%H%M%S)   # or reuse dual-arm stamp directory
OUT="${NODE4_WORKSPACE:-$PWD/workspace}/juice-dual/$STAMP"

npx tsx src/standalone.ts \
  --task-id "juice-soft-${STAMP}" \
  --engagement pentest \
  --graph-id app_assessment \
  --target "http://127.0.0.1:3000" \
  --scope "127.0.0.1,localhost,host.docker.internal" \
  --instruction-file "$OUT/instruction-juice.txt" \
  --output "$OUT"
```

Optional explicit soft Main act (product default; only needed if env was polluted):

```bash
# --graph-main-act soft  → graphMainAct=delegate_preferred
# or: export NODE4_GRAPH_MAIN_ACT=delegate_preferred
```

**Do not** pass `--graph-main-act hard` for the control arm (that is lab strip, not product soft).

### 2.3 Practical launch — platform UI

1. Node4 process online (`npm run dev` / `tsx src/main.ts`) with **`pentest` installed** and bound to platform.
2. Conversation: pick expert **pentest** (toolbar / `@`).
3. Engagement template: **应用评估 (Graph)** → `app_assessment` (not free; not redteam_deep).
4. Structured target/scope for Juice (asset「创建任务」or message path that attaches target/scope — empty target → chat-only).
5. Instruction: authorized local lab goals; **no** challenge answer keys.
6. Platform sends `task_assign` with `engagement=pentest`, `engagement_template=app_assessment`, `allow_postex=false` (template-derived).

Soft work_mode telemetry: `graph:app_assessment:delegate_preferred` (from session start status).

### 2.4 Soft graph definition (product)

- File: `experts/pentest/graphs/app_assessment.json`
- `roe.allow_postex: false`
- Soft `default_plan`: surface → prior_reverify → auth_session → class_probe → … → validate_book
- Nodes may `subagent: true`; Main books; product Main act = delegate_preferred unless lab override

---

## 3. Artifacts: taskDir, findings, sessions, dual-arm copy layout

### 3.1 Where runs land

| Setting | Value |
|---------|--------|
| Workspace root | `config.workspaceDir` = `NODE4_WORKSPACE` \|\| `NODE2_WORKSPACE` \|\| `./workspace` (resolved under `node4/` when relative) |
| Standalone override | `--output <dir>` sets `config.workspaceDir` |
| **taskDir** | `{workspaceDir}/{taskId}` (`session-runner.ts`) |

### 3.2 Parent taskDir layout (both arms create parent dirs)

Created at task start:

- `evidence/`, `findings/`, `scripts/`, `subagents/`, `facts/`, `surfaces/` (+ ledger), `tool-output/`
- `events.jsonl`
- Soft Main path also uses `pi-sessions/` under **taskDir**
- Cookie jars: `session/` under the runtime `taskDir` used by the `session` tool

Post-run inspect (soft path): e.g. `agent-summary.json`, `transcript.jsonl`, `session-manifest.json`, `goals-snapshot.json` (observed on real workspace samples).

### 3.3 Hard-only subtree

| Path | Role |
|------|------|
| `taskDir/hard-graph/run-result.json` | Runner terminal + per-stage outcomes |
| `taskDir/hard-graph/<graphId>/stage-<i>-<stageId>/` | Per-stage workDir |
| `…/result.json` | Stage structured result (required by stage executor) |
| `…/normalized-result.json` | Normalized handoff |
| `…/pi-sessions/` | Stage pi sessions |
| `…/evidence/`, `…/facts/` | Stage-local stores |
| Parent `findings/`, `surfaces/` | Shared with parent (booking / ledger) |
| A4 | seed `parent session/` → stage; promote stage → parent after stage |

Hard status stream: `work_mode=hard_graph:app_assessment_thin`, `agent_phase=hard_graph`.

### 3.4 Soft-only signals

| Path / signal | Role |
|---------------|------|
| `taskDir/pi-sessions/` | Main pi session |
| `taskDir/subagents/<id>/` | Child packages (batch fan-out) |
| `work_mode=graph:app_assessment:delegate_preferred` | Soft graph start status |
| **No** `hard-graph/` tree | Confirms arm is not Hard runner |

### 3.5 Suggested copy under `benchmarks/juice-discovery/runs/<stamp>/`

Tree does not exist until map prototype/freeze; recommended offline harvest (no answer keys):

```text
benchmarks/juice-discovery/runs/<stamp>/
  meta.md                    # model, STAMP, target URL, RoE, wall clock, NODE4_* env
  instruction-juice.txt      # shared instruction both arms
  hard/
    taskDir/                 # or rsync of juice-hard-* taskDir
      findings/
      surfaces/ledger.json
      hard-graph/run-result.json
      hard-graph/**/result.json
      events.jsonl
      agent-summary.json      # if present
  soft/
    taskDir/
      findings/
      surfaces/ledger.json
      subagents/             # optional large; or list + sample
      pi-sessions/           # optional; large
      events.jsonl
      agent-summary.json
  # scorecard filled later by map task — not this research ticket
```

**Copy policy hints (for freeze ticket, not decided here):** prefer findings + ledgers + `run-result.json` + instruction + short meta; gitignore bulky `tool-output/`, full pi session logs if huge; never commit Juice write-up spoilers into product trees.

### 3.6 Historical reference (not control arm)

`benchmarks/omp-juice-20260719/` — OMP-class lab artifact (`PROMPT.md`, `findings/`, `sessions/`, `notes/SUMMARY.md`). Use only as methodology/offline density reference, **not** as product soft invocation or Hard claim.

---

## 4. Fairness footguns (dual-arm comparison)

### 4.1 Launch / labeling

| Footgun | Why unfair / wrong |
|---------|-------------------|
| Using `bench-dvwa-work-modes.sh` **hard** as Hard primary | Lab Main-act strip on soft graph; still OMP Main + subagents; **not** `app_assessment_thin` runner |
| Soft arm with `NODE4_HARD_GRAPH=1` still set | Soft intent silently becomes thin Hard |
| Soft arm as free OMP while scorecard says “product soft Graph” | Different work_mode than UI `app_assessment` |
| Soft arm as `redteam_deep` | Post-ex ON vs Hard thin post-ex OFF |
| Claiming OMP Juice 2026-07-19 directory as soft control | Map C1 forbids; different code era / path |

### 4.2 Budgets / model / harness env

Keep **identical** across arms unless scorecard notes deliberate difference:

| Knob | Product default (harness) | Script traps |
|------|---------------------------|--------------|
| Model | `PI_MODEL_PROVIDER` / `PI_MODEL` | `bench-three-targets.sh` / DVWA bench set model — match both arms |
| Outer continues | Product: outer recovery **off** unless lab `NODE4_MAX_*` | `bench-three-targets.sh` sets `NODE4_MAX_CONTINUES=8` etc.; DVWA modes script forces continues **0** — **do not** give soft extra outer continues while Hard has none |
| Main max turns | `NODE4_MAIN_MAX_TURNS` (config clamp) | Soft Main loop only; Hard stages have their own pi sessions — different shape; note on scorecard |
| Wall clock | Map suggests ≤2h/arm | Operator stop; record overrun |
| Subagent concurrency | `NODE4_SUBAGENT_CONCURRENCY` (soft only; default 8) | Hard thin has **no** subagent tool |

Hard stage isolation vs soft single long Main loop is an **intrinsic** asymmetry (see capability-gaps research A1–A4) — score process/stage honesty, not raw finding-count SLA.

### 4.3 Tools / orchestration asymmetry (expected, must disclose)

| Capability | Hard thin | Product soft `app_assessment` |
|------------|-----------|--------------------------------|
| Stage order owner | Hard Graph runner | Main + soft plan (assistive) |
| `subagent` batch fan-out | **No** (allowlist + stage depth) | **Yes** |
| Main dense act (shell/http/…) | Per-stage profile; book stage has **no** act | Main may act (delegate_preferred) |
| Booking tools | `finding` mainly on `validate_book` | Main books throughout |
| Fail-closed stage gates | `surfaces_min` etc. | Soft acceptance assistive; settlement ≠ N findings |
| Cookie continuity | A4 seed/promote parent↔stage | Parent session + subagent promote |

### 4.4 Target / RoE / instruction parity checklist

Same for both arms:

- [ ] Target `http://127.0.0.1:3000`
- [ ] Scope hosts identical
- [ ] Instruction file **byte-identical** (no arm-specific challenge hints)
- [ ] Post-ex **false** (app_assessment class)
- [ ] Same model + API base
- [ ] `pentest` pack same install version
- [ ] Pen-sandbox / doctor env same (doctor non-gating but tool availability should match)
- [ ] Sequential order: **Hard first, then soft** (map E1); document Juice instance reset choice on scorecard (not frozen here)

### 4.5 Platform dual-arm on one Node

If soft uses UI and Hard uses env on the **same** Node4 process, Hard env pollutes soft. Prefer **standalone both arms** with isolated env, or separate Node processes/workspaces (`--output` / `NODE4_WORKSPACE` per arm).

### 4.6 Gaps (inventory, not implementation)

| Gap | Impact |
|-----|--------|
| `standalone.ts` has no `--graph-discipline` | Hard via alias id or env only |
| `main.ts` drops `graphDiscipline` | Platform cannot pass structured hard discipline even if UI added field without Node change |
| UI has no Hard Graph template | Operators cannot click Hard primary in product UI |
| No first-class `juice-dual` script | Operators must compose standalone invocations (this note) |
| `benchmarks/juice-discovery/` layout not frozen | Use §3.5 as research proposal until #49/#51 |

---

## 5. Operator checklist (dual-arm protocol sketch)

```text
0. Lab Juice up @ 127.0.0.1:3000; pentest installed; model env set
1. Shared OUT=…/juice-dual/<stamp>; write instruction-juice.txt (no answer keys)
2. HARD arm (standalone):
     unset NODE4_GRAPH_MAIN_ACT pollution; do NOT leave NODE4_HARD_GRAPH for step 3
     --engagement pentest --graph-id app_assessment_thin
     --target/--scope as above --output OUT --task-id juice-hard-<stamp>
3. Record hard terminal, run-result.json, findings count, wall clock
4. (Optional) Juice reset — note on scorecard
5. SOFT arm (standalone preferred for parity):
     unset NODE4_HARD_GRAPH
     --engagement pentest --graph-id app_assessment
     same instruction/target/scope/model --task-id juice-soft-<stamp>
6. Harvest into benchmarks/juice-discovery/runs/<stamp>/{hard,soft}/ …
7. Fill offline scorecard (separate map task) — no finding-count product SLA
```

Verify arm identity after run:

| Check | Hard | Soft |
|-------|------|------|
| `taskDir/hard-graph/run-result.json` | present | absent |
| Status / work_mode | `hard_graph:app_assessment_thin` | `graph:app_assessment:delegate_preferred` (or free if misconfigured) |

---

## 6. Non-goals of this note

- No live Juice execution or scoring.
- No new CLI flags, UI Hard selector, or platform `graph_discipline` plumbing.
- No scorecard field design (#49/#51).
- No challenge lists / write-up spoilers in product paths.
- No Node5 elevation; no claim that OMP historical juice tree is product soft.

---

## 7. One-line residual risk

If operators treat DVWA bench **`hard`** (Main-act strip) or free OMP / historical `omp-juice-20260719` as the map arms, the dual-arm Juice protocol will compare **the wrong pair of runtimes** and the scorecard will not measure Hard Graph thin vs **product** soft Node4.
