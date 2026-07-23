# Research: Node5 lab invocation for Juice Shop and DVWA

**Ticket:** [#62](https://github.com/zangjiaao/my-ai-pen/issues/62)  
**Parent map:** [#59](https://github.com/zangjiaao/my-ai-pen/issues/59)  
**Canonical path:** `docs/wayfinder/node5-lab-invocation-juice-dvwa.md`  
**Branch:** `research/node5-lab-invocation-juice-dvwa`  
**Date:** 2026-07-24  
**Method:** Primary-source inventory (`node5/` CLI + source + README + `pyproject.toml` + `node5/workspace/*` EVAL/run artifacts + living docs). **No live Juice/DVWA attack runs.**  
**Related:** Hard Node4 standalone dual-arm research — [`hard-soft-juice-arm-invocation.md`](./hard-soft-juice-arm-invocation.md) (#50). ADR: `docs/adr/0001-graph-x-pi-product-path.md` (Node5 = lab / semantic reference / fallback B only).

---

## Executive answer

| Question | Answer from primary sources |
|----------|-----------------------------|
| How to invoke Node5 | **CLI only:** `python -m node5 run` (or console script `node5`) from `node5/` with editable install. **No** platform citizen / WS / UI. |
| Pack / graph entry | Default **`--graph-id app_assessment`** → loads monorepo `experts/pentest/graphs/app_assessment.json` (soft pack graph file). Plan = that file’s `default_plan`. **Not** Node4 Hard thin `graphs/hard/app_assessment_thin.json` (loader does not resolve `hard/`). |
| Juice target | `http://127.0.0.1:3000` (repo `docker-compose.targets.yml` / historical `run_meta.json`) |
| DVWA target | `http://127.0.0.1:8080` (same compose; historical workspace runs) |
| Artifact root | `--work-dir` or default `node5/workspace/run-<UTC stamp>/` |
| Harvest parity with Hard Node4 | **Comparable process signals exist** (`findings.json`, `state.json`, `summary.json` with `coverage_metrics` / `process_metrics`, `run_meta.json`, `events.json`) but **layout and runtime are never 1:1** (flat PenState dump vs `taskDir/hard-graph/…`; ADK vs Graph×Pi). |
| EVAL.md | **Human / lab write-up**, not emitted by the runner. Present on many historical workspace dirs. |

**Vocabulary trap (same class as #50):** Node5 README “hard Task Graph” means **ADK sequential Workflow** over pack stage names. It is **not** product Hard Graph thin (`app_assessment_thin` / `NODE4_HARD_GRAPH`). Comparing Node5 to Node4 requires labeling arms carefully.

---

## Sources consulted

| Area | Paths |
|------|--------|
| CLI / entry | `node5/src/node5/cli.py`, `__main__.py`, `pyproject.toml` (`node5 = node5.cli:main`) |
| Run + work dir | `node5/src/node5/run.py` |
| Config / dotenv | `node5/src/node5/config.py` |
| Pack / graph load | `node5/src/node5/pack_loader.py` |
| Workflow assembly | `node5/src/node5/workflow.py` |
| Finalize artifacts | `node5/src/node5/stages.py` (`finalize_node`) |
| Sandbox | `node5/src/node5/sandbox_exec.py`, README sandbox table |
| Product status | `node5/README.md`, ADR `0001`, `AGENTS.md` |
| Soft pack graph | `experts/pentest/graphs/app_assessment.json` |
| Hard thin (Node4 only) | `experts/pentest/graphs/hard/app_assessment_thin.json` |
| Lab targets | root `README.md` (`docker-compose.targets.yml` DVWA :8080, Juice :3000) |
| Hard Node4 harvest | `docs/wayfinder/hard-soft-juice-arm-invocation.md` |
| Historical lab arms | `node5/workspace/juice-v*` (incl. **juice-v11-depth-***, **juice-v16-**), `node5/workspace/dvwa-*` (gitignored locally; present on lab machines) |

---

## 1. Exact invocation (CLI, env, pack, graph)

### 1.1 Install / module entry

```bash
cd node5
source .venv/bin/activate   # or create: uv venv && source .venv/bin/activate
uv pip install -e .

# entrypoints (equivalent)
python -m node5 --help
node5 --help                # project.scripts console entry
```

Subcommands (from `cli.py`):

| Cmd | Role |
|-----|------|
| `run` | Execute ADK hard-order workflow for a pack graph |
| `describe` | Print three-layer Graph JSON (`default_plan` from pack) |
| `config` | Redacted model/env resolution |

### 1.2 Model / LLM env (inherits Node4 keys)

`config.py` + `maybe_load_dotenv()`:

1. Load `node5/.env` (if present, no override of already-set env).
2. Fall back to `node4/.env` (same monorepo model/gateway keys).

| Variable | Role |
|----------|------|
| `PI_MODEL_PROVIDER` / `NODE5_MODEL_PROVIDER` | Provider label (default `deepseek`) |
| `PI_MODEL` / `NODE5_MODEL` / `MODEL` | Model id (default `deepseek-v4-flash`) |
| `LLM_BASE_URL` / `OPENAI_BASE_URL` / `OPENAI_API_BASE` | OpenAI-compatible gateway (e.g. OpenCode Zen) |
| `LLM_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` | API key |
| `LLM_API` | default `openai-completions` |
| `LLM_CONTEXT_WINDOW`, `LLM_MAX_TOKENS` | context / completion |
| `NODE5_STAGE_MAX_LLM_CALLS` | per-stage LLM call budget (default 24) |

Live `run` without key (and without Gemini env) exits **2** with tip that `node4/.env` is auto-loaded.

### 1.3 Sandbox / tooling env (default force pen-sandbox)

From README + `sandbox_exec.py`. Live run **aborts** if sandbox health fails unless dry-run or host tools allowed (`run.py`).

| Variable | Default / meaning |
|----------|-------------------|
| `NODE5_SANDBOX` | `1` force; `0`/`host` allow host tools |
| `NODE5_ALLOW_HOST_TOOLS` | explicit host fallback |
| `PEN_SANDBOX_IMAGE` / `NODE5_PEN_SANDBOX_IMAGE` | default `pen-sandbox:dev` |
| `NODE5_SANDBOX_NETWORK` | default **`host`** (lab `127.0.0.1` targets) |
| `NODE5_DOCKER_BIN` / `NODE4_DOCKER_BIN` | docker binary |
| `NODE5_BROWSER` | optional browser tool (`auto`/`1`/`0`) |
| `NODE5_BROWSER_PROBE` | default `1` health-probe agent-browser in sandbox |
| `NODE5_BROWSER_SPA_WAIT_MS` | SPA settle ms (default 3000) |
| `NODE5_DEEP_WORKER_MAX_EVENTS` | deep skill worker cap (default 180) |
| `NODE5_CHAIN_MAX_EVENTS` | identity_chain pass cap (default 300) |
| `NODE5_CHAIN_FORCE_CONTINUE_TOOLS` | force pass1 when tools≥N (default 20) |
| `NODE5_DOM_WORKER_MAX_EVENTS` | xss-dom worker (default 160) |
| `NODE5_AUTH_SESSION_MAX_EVENTS` | auth_session captain cap (default 72) |

Build sandbox from repo root: `bash sandbox/pen-sandbox/scripts/build.sh`.

### 1.4 Pack / graph entry (important)

```text
default_pack_root() → <repo>/experts/pentest
load_graph(pack, graph_id) → experts/pentest/graphs/{graph_id}.json
```

| Knob | CLI | Default |
|------|-----|---------|
| Pack root | `--pack-root` | monorepo `experts/pentest` (CWD walk or package parents) |
| Graph id | `--graph-id` | **`app_assessment`** |
| RoE post-ex | `--allow-postex` | false from graph `roe.allow_postex` |
| Agent fan-out | `--agent-graph` / `--no-agent-graph` | **on** |
| Workers | `--max-workers` | 4 (clamped 1–8) |
| Stage filter | `--only-stages a,b,c` | empty = run all plan stages (filter **skips** stages not listed; does **not** insert missing ones) |
| Work dir | `--work-dir` | `node5/workspace/run-<UTC>/` |
| Notes | `--notes` | injected into every stage as `operator_notes` |
| Model override | `--model` | env default |

**Current `describe` plan on main** (soft pack file, verified via `python -m node5 describe`):

```text
START → init → surface → prior_reverify → auth_session → class_probe
     → authz_logic → component → validate_book → finalize
```

**Not** in current pack `default_plan`: `coverage_probe`.  
Node5 **implements** `coverage_probe` (`stages.py`, `coverage_probes.py`) and documents it in README / `WORKER_STAGES` constant, but **workflow assembly uses pack `default_plan` only** — `WORKER_STAGES` is **not** wired into `build_app_assessment_workflow`. Historical Juice runs **v10+** still show `coverage_probe` in `stages_done` (local/pre-commit era plan differed). Operators who need juice-v11-class coverage stage must treat **plan drift** as a gap (see §3 / §5); this ticket does **not** patch product graphs.

**Cannot** pass `--graph-id app_assessment_thin` as Node4 Hard primary: loader looks for `graphs/app_assessment_thin.json`, not `graphs/hard/app_assessment_thin.json`. Hard thin remains a **Node4** graph file.

### 1.5 Juice Shop — recommended lab command shape

Prereqs: targets up, sandbox image, model env, editable install.

```bash
# Lab target (repo root)
docker compose -f docker-compose.targets.yml up -d   # Juice Shop :3000

cd node5
source .venv/bin/activate

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="workspace/juice-lab-${STAMP}"
mkdir -p "$OUT"

# Optional structure check (no LLM/network)
python -m node5 run --target http://127.0.0.1:3000 --dry-run --work-dir "$OUT-dry"

# Live control arm (historical lab shape)
python -m node5 run \
  --target "http://127.0.0.1:3000" \
  --graph-id app_assessment \
  --work-dir "$OUT" \
  --max-workers 4 \
  --notes "Authorized OWASP Juice Shop lab on 127.0.0.1:3000 only. Scope this host. No challenge write-ups as answer keys."
# redirect console:  2>&1 | tee "$OUT/console.log"
```

Evidence from historical successful arms:

| Artifact | Target | Graph | Model (run_meta) | Notes (state.operator_notes, truncated sense) |
|----------|--------|-------|------------------|-----------------------------------------------|
| `juice-v11-depth-20260722T014530Z` | `http://127.0.0.1:3000` | `app_assessment` | deepseek-v4-flash | Authorized Juice lab; depth/coverage intent |
| `juice-v16-chain-dom-20260722T221551Z` | same | same | deepseek-v4-pro | same host; chain/DOM experiment notes |

Do **not** paste Juice challenge keys / scoreboard solutions into `--notes` (map / harness rules; scorecard R1 class).

### 1.6 DVWA — recommended lab command shape

```bash
docker compose -f docker-compose.targets.yml up -d   # DVWA :8080

cd node5
source .venv/bin/activate

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="workspace/dvwa-lab-${STAMP}"
mkdir -p "$OUT"

python -m node5 run \
  --target "http://127.0.0.1:8080" \
  --graph-id app_assessment \
  --work-dir "$OUT" \
  --max-workers 4 \
  --notes "Authorized DVWA lab. Scope: this origin only. Prefer security=low. Use default lab login if needed for session. Surface should list module paths in surfaces[]."
# 2>&1 | tee "$OUT/cli.log"
```

Historical `dvwa-v6-salvage-20260721T151017Z`:

| Field | Value |
|-------|--------|
| target | `http://127.0.0.1:8080` |
| graph_id | `app_assessment` |
| model | deepseek-v4-flash |
| stages_done | init…class_probe…validate_book…finalize (**no** `coverage_probe` on that run) |
| findings | 13 (`run_meta.finding_count`) |

Dry-run surface seeds in `stages.py` intentionally include DVWA-shaped paths (`/login.php`, `/vulnerabilities/…`) for structure control only — not a production fingerprint gate.

### 1.7 Operator checklist (Node5 control arm only)

```text
0. Juice :3000 and/or DVWA :8080 up; pen-sandbox built; node5 editable install
1. Model: node4/.env or env (PI_MODEL / LLM_*); python -m node5 config
2. Sandbox health path: default NODE5_SANDBOX=1, network host
3. OUT=node5/workspace/<label>-<UTC>; optional tee console.log|cli.log
4. python -m node5 run --target <url> --graph-id app_assessment --work-dir OUT --notes "…"
5. Harvest: findings.json state.json summary.json run_meta.json events.json (+ EVAL.md if human writes one)
6. Label arm as Node5-ADK lab control — not product Hard Graph thin
```

---

## 2. Expected output paths (harvest map)

### 2.1 Work directory

| Setting | Path |
|---------|------|
| Default | `node5/workspace/run-<YYYYMMDDTHHMMSSZ>/` (`run.default_work_dir`) |
| Override | `--work-dir <dir>` (mkdir by runner) |
| Git | `node5/workspace/` is **gitignore**’d (local lab only unless force-added) |

### 2.2 Files written by the runner

| File | Writer | Contents |
|------|--------|----------|
| `run_meta.json` | `run.py` start + end | model_label, target, graph_id, dry_run, agent_graph, max_workers, started_at/finished_at, tooling_health, finding_count, error_count |
| `events.json` | `run.py` progressive + final | ADK event log (author, stage, stages_done, short text) |
| `state.partial.json` | `run.py` mid-run | latest PenState checkpoint |
| `state.json` | `finalize_node` | full public PenState (surfaces, candidates, findings, coverage_ledger, feedback, notes, …) |
| `findings.json` | `finalize_node` | array of booked findings (`model_dump`) |
| `summary.json` | `finalize_node` | severity histogram, layers, **`coverage_metrics`**, **`hv_metrics`**, **`process_metrics`**, stages_done, feedback tail, notes_tail |

CLI also prints a short JSON summary to stdout and `artifacts: <abs path>` on stderr.

### 2.3 Process metrics (where)

- **`summary.json` → `process_metrics`** (from `feedback.process_quality_metrics`):  
  `structure_fail_n`, `discovery_yield_soft_fail_n`, `retry_n`, `ready_by_stage`, `class_probe_discovery_yield`, note that process quality is **orthogonal** to `coverage_attempt_rate` (README).
- **`summary.json` → `coverage_metrics`**: required/attempted/closed/failed/blocked/untested lists + rates.
- Present on later Juice workspace summaries (e.g. **juice-v12+**); older runs (v11, dvwa-v6) may lack `process_metrics` key even when coverage exists.

### 2.4 EVAL.md (not runner output)

| Fact | Source |
|------|--------|
| Not written by `run.py` / `finalize_node` | code inventory |
| Lab human write-ups under workspace | many `EVAL.md` next to run dirs |
| Canonical depth re-eval pointer | README → `workspace/juice-v11-depth-*/EVAL.md` |

Operators who want “comparable harvest” to Hard Node4 should treat **EVAL.md as optional offline narrative**, not as a machine contract.

### 2.5 Console logs (operator-captured)

Historical dirs use either `console.log` or `cli.log` — **tee of process stderr/stdout**, not a first-class runner file. Recommend:

```bash
python -m node5 run ... 2>&1 | tee "$OUT/console.log"
```

### 2.6 Suggested dual-arm copy layout (research proposal; not frozen)

When comparing Node5 control arm to Hard Node4 standalone (see #50 §3.5), a practical offline tree:

```text
benchmarks/<segment>/runs/<stamp>/   # or lab-only mirror
  meta.md                 # model, STAMP, targets, env, wall clock; no answer keys
  hard-node4/             # from Node4 standalone taskDir harvest
  node5/
    run_meta.json
    findings.json
    state.json            # or state slice
    summary.json          # process_metrics + coverage_metrics
    events.json           # optional bulk
    EVAL.md               # if human
    console.log           # if tee'd
```

Copy policy: prefer `findings.json` + `summary.json` + `run_meta.json` + short meta; skip bulky event noise if needed; **never** commit challenge spoilers into product trees.

---

## 3. Gaps vs Hard Node4 standalone (never 1:1)

| Dimension | Hard Node4 standalone (`app_assessment_thin`) | Node5 CLI (`app_assessment` ADK) | 1:1? |
|-----------|-----------------------------------------------|----------------------------------|------|
| Product status | Product path Graph × Pi (ADR 0001) | Lab / semantic reference / fallback B | No |
| Launch | `npx tsx src/standalone.ts --graph-id app_assessment_thin …` | `python -m node5 run --graph-id app_assessment …` | No |
| Platform | Can bind WS (Hard usually standalone for dual-arm) | **CLI only** — no `task_assign` | No |
| Graph file | `graphs/hard/app_assessment_thin.json` (thin stages) | Soft pack `graphs/app_assessment.json` stage names, ADK hard **order** | No |
| Stage set | init → surface → class_probe → validate_book | Full soft plan (+ historically coverage_probe) | No |
| Agent Runtime | pi-ai / pi-agent-core stages | Google ADK Workflow + LiteLlm | No |
| Agent Graph | Hard thin: **no** subagent tool | `class_probe` skill **fan-out workers** (CLI) | No |
| Feedback | Hard fail-closed stage require + harness | Explicit `feedback[]` + coverage + process_quality | Partial semantic only |
| Scope CLI | `--scope` hosts | **No** `--scope`; scope via `--notes` prose | No |
| Engagement / RoE map | `--engagement` + template / allow_postex | Graph roe + `--allow-postex` only | Partial |
| Artifact root | `{workspace}/{taskId}/` | flat `--work-dir` | No |
| Findings | `findings/` (files) + booking tools | single `findings.json` | No |
| Hard runner tree | `hard-graph/run-result.json`, per-stage dirs, pi-sessions | **absent** | No |
| State | parent surfaces ledger, session jars, promote | `state.json` PenState (cookies, actor_cookies, coverage_ledger) | No |
| Events | `events.jsonl` | `events.json` (ADK-shaped) | No |
| process_metrics | different shape / settlement | `summary.process_metrics` | No |
| EVAL.md | optional human | optional human (Node5 lab culture) | same class |
| Sandbox knobs | NODE4 / pen-tools family | `NODE5_*` (aligned image, separate flags) | Partial |
| Default workdir git | `node4/workspace/` ignored | `node5/workspace/` ignored | same |

**Intrinsic asymmetry to disclose on any dual-arm scorecard:** Node5 measures a **different orchestration kernel** (ADK three-layer model with rich stage plan and coverage Feedback) against Node4 Hard thin (few stages, pi per stage, product booking). Fair comparison is **process honesty / capability classes**, not finding-count SLA or identical paths.

---

## 4. Existing Juice / DVWA lab artifacts (pointers)

Workspace is gitignored; paths below are **on-disk lab inventory** at research time (absolute under repo):

### 4.1 Juice (representative)

| Dir | Role | Notes |
|-----|------|-------|
| `/mnt/d/Coding/my-ai-pen/node5/workspace/juice-v11-depth-20260722T014530Z/` | **README-cited depth re-eval** | `EVAL.md`, full harvest; target :3000; 13 findings; coverage attempt_rate 1.0; stages include `coverage_probe` |
| `…/juice-v10-coverage-20260722T002725Z/` | coverage Feedback series | EVAL + harvest |
| `…/juice-v12-pro-` … `juice-v16-chain-dom-` | later depth/pro/sandbox/chain | process_metrics appear from ~v12; v16 EVAL + browser_ok tooling_health |
| `…/juice-v1-` … `juice-v9-` | earlier evolution | mix of cli.log / console.log |
| `…/juice-v17-chain-dom-fix-*` | partial / aborted | often only console + partial state |

### 4.2 DVWA (representative)

| Dir | Role | Notes |
|-----|------|-------|
| `/mnt/d/Coding/my-ai-pen/node5/workspace/dvwa-v6-salvage-20260721T151017Z/` | latest complete DVWA series + EVAL | target :8080; 13 findings; surface salvage narrative |
| `…/dvwa-v5-p0-*`, `dvwa-v4-dedupe-*`, `dvwa-v3-*`, `dvwa-v2-*`, `dvwa-live-*` | prior iterations | most have EVAL except some partial live |

### 4.3 Canonical machine files on a complete run

```text
node5/workspace/<label>-<UTC>/
  run_meta.json
  events.json
  state.partial.json   # mid-run
  state.json           # finalize
  findings.json
  summary.json         # coverage_metrics, process_metrics (when era supports)
  EVAL.md              # human (if present)
  console.log|cli.log  # operator tee (if present)
```

---

## 5. Plan drift: `coverage_probe` (operator-facing caveat)

| Signal | Observation |
|--------|-------------|
| README Task Graph diagram | includes `coverage_probe` after `class_probe` |
| `workflow.WORKER_STAGES` | includes `coverage_probe` |
| `stages.py` / `coverage_probes.py` | full implementation |
| `python -m node5 describe` (current main) | **plan omits** `coverage_probe` |
| Pack `app_assessment.json` `default_plan` | surface…class_probe → authz_logic (no coverage_probe) |
| Historical juice-v10+ `stages_done` | **includes** `coverage_probe` |
| Historical dvwa-v6 `stages_done` | **omits** `coverage_probe` |

**Implication for #59 control arm:** re-running “like juice-v11” on **current main** without a deliberate plan change will **not** automatically re-enter the coverage_probe stage. Fixing that is **out of scope** for this research ticket (would be a Node5 workflow or pack decision, not product Hard Graph work). Document only.

---

## 6. Fairness footguns (Node5 vs Hard Node4)

| Footgun | Why wrong |
|---------|-----------|
| Calling Node5 “product Hard Graph” | ADR freezes Node5 as lab/fallback B; Hard Graph is Node4 thin path |
| Using `--graph-id app_assessment_thin` on Node5 | file not at `graphs/app_assessment_thin.json` |
| Matching finding counts as pass/fail | different kernels + gates; map style is process/capability honesty |
| Shared dirty target across arms | same dual-arm hygiene as Juice discovery map |
| Leaving host-tool fallback on for one arm only | tooling asymmetry |
| Putting challenge write-ups in `--notes` | answer-key contamination (harness / scorecard R1) |
| Expecting `hard-graph/run-result.json` under Node5 work-dir | never produced |
| Expecting auto `EVAL.md` | human only |

---

## 7. Non-goals of this note

- No live Juice/DVWA execution or scoring.
- No protocol freeze / dual-arm scorecard design (human / other tickets).
- No Node5 product elevation or platform adapter.
- No Node4 optimization.
- No patch to re-wire `coverage_probe` into pack `default_plan`.

---

## 8. Resolution summary (for #62)

1. **Invoke:** `cd node5 && python -m node5 run --target <url> --graph-id app_assessment --work-dir workspace/<label>-<UTC> --notes "…" --max-workers 4` with model env from `node4/.env` / `LLM_*` and default pen-sandbox (`NODE5_SANDBOX=1`, network host).  
2. **Targets:** Juice `http://127.0.0.1:3000`; DVWA `http://127.0.0.1:8080`.  
3. **Harvest:** `findings.json`, `state.json`, `summary.json` (`process_metrics` + `coverage_metrics`), `run_meta.json`, `events.json`; optional human `EVAL.md` + tee log.  
4. **Never 1:1 vs Hard Node4:** different graph file, stage set, runtime, artifact tree, scope/engagement CLI, platform attachment.  
5. **Existing arms:** `node5/workspace/juice-v11-depth-*` (README depth re-eval), later juice-v12…v16, `dvwa-v6-salvage-*` and prior `dvwa-*` EVAL series (local gitignored workspace).  
6. **Caveat:** current pack plan may omit `coverage_probe` despite implementation + historical Juice stages — call out on any control-arm protocol freeze.
