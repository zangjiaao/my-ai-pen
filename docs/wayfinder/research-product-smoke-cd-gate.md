# Research: product-smoke truth today vs Phase A CD gate

> Ticket: GitHub **#227** · Map **#151** (internal beta deploy package)  
> Repo sources only — **no product feature code** in this resolution.  
> Date: 2026-07-28 · branch `research/product-smoke-cd-gate` (base main `3378b8c`)

## Question

Map #151 **Order-S** says CD gates on **current** product-smoke; Phase A raises the bar later and does **not** block first install. What is true **today**?

1. What jobs/steps does `.github/workflows/product-smoke.yml` actually run (paths, commands)?
2. What does `docs/specs/ci-cd.md` claim Phase A should add, and which of those suites **exist** in-repo right now?
3. Recommended **CD gate** for first SSH deploy workflow: reuse product-smoke as-is, or a named subset?
4. List Phase A follow-ups as a prioritized checklist (no implementation).

Primary sources: workflow YAML, package.json scripts, platform tests, `docs/specs/ci-cd.md`, related test files.

---

## Executive answer

| # | Answer |
|---|--------|
| **1. Today’s workflow** | **Two jobs only:** `frontend-build` (`platform/frontend`: `npm ci` + `npm run build`) and `node4-smoke` (`node4`: `npm ci` + `npx tsx src/node4-smoke.ts` with `CI=1`). Path filters: `platform/**`, `node4/**`, `experts/**`, workflow file. **No** backend Python tests, **no** `test:agent-language`, **no** `shared/**` trigger, **no** Node `tsc`/hard-graph suite. |
| **2. Phase A claim vs repo** | Phase A asks for deterministic suites: Node `test:agent-language`, platform `tests/test_agent_language.py`, and `shared/**` path triggers + doc/workflow honesty. **All named suites and catalog lock tests already exist in-repo** and run locally; **none are wired into product-smoke**. |
| **3. First SSH CD gate** | **Reuse `product-smoke` as-is** (same workflow / same two jobs). Do **not** invent a lighter named subset for first install. Order-S + CD-A: green product-smoke → SSH pull/rebuild/restart; Phase A later **raises the same named gate**, not a parallel “deploy-lite” job. |
| **4. Phase A checklist** | Wire existing language/catalog suites + `shared/**` filters first (closes CICD-LANG-1); then optional pure backend unit expansion and doc alignment; keep Phase B (hard-graph / runtime / broader pytest) and LANG-2..6 hygiene out of the first CD bar. |

**One sentence:** Product CI today is a **minimal FE build + Node4 in-process smoke**; Phase A’s higher bar is **already implementable from existing tests** but is **not** the first-install CD gate — first SSH deploy should depend on **today’s** `product-smoke` unchanged.

---

## 1. What `product-smoke.yml` actually runs

Source of truth: [`.github/workflows/product-smoke.yml`](../../.github/workflows/product-smoke.yml) (only other GHA product-adjacent workflow: `pen-sandbox.yml`, image build — **not** product deploy gate).

### 1.1 Triggers

| Event | Branches | Path filters |
|-------|----------|--------------|
| `push` | `main` only | `platform/**`, `node4/**`, `experts/**`, `.github/workflows/product-smoke.yml` |
| `pull_request` | (any, path-filtered) | same four globs |

**Not** in path filters: `shared/**`, `docs/**`, root compose/env, sandbox (separate workflow), legacy `node/` / `node2/` / `node3/`, `research/`, `benchmarks/`.

No `workflow_dispatch`, no `workflow_call`, no deploy job, no secrets, no services (Postgres/RabbitMQ).

### 1.2 Jobs and steps (literal)

#### Job `frontend-build`

| Field | Value |
|-------|--------|
| Runner | `ubuntu-latest` |
| `working-directory` | `platform/frontend` |
| Steps | `actions/checkout@v4` → `actions/setup-node@v4` (Node **22**, npm cache on `platform/frontend/package-lock.json`) → `npm ci` → **`npm run build`** |

`platform/frontend/package.json` defines:

```text
"build": "tsc -b && vite build"
```

So this job **already typechecks** the frontend (`tsc -b`) and produces a production Vite bundle. It does **not** run frontend unit tests (none wired).

#### Job `node4-smoke`

| Field | Value |
|-------|--------|
| Runner | `ubuntu-latest` |
| `working-directory` | `node4` |
| Steps | `actions/checkout@v4` → `actions/setup-node@v4` (Node **22**, npm cache on `node4/package-lock.json`) → `npm ci` → **`npx tsx src/node4-smoke.ts`** |
| Env | `CI: "1"` (comment: no live LLM required for unit smokes) |

Equivalent local script: `node4` `"smoke": "tsx src/node4-smoke.ts"`.

`node4/src/node4-smoke.ts` is a large (~1.5k-line) in-process harness that exercises role packs, subagent, goals, booking, shell, tools surface, panel agents, CTF/session/browser/captcha seams, etc., and exits non-zero on assertion failure. It is **not** the same as `npm run test:agent-language`, `test:hard-graph`, or `test:runtime`.

### 1.3 Explicitly absent from product-smoke today

| Area | In-repo? | In product-smoke? |
|------|----------|-------------------|
| Platform backend install / unittest / pytest | Yes (`platform/backend/tests/`) | **No** |
| Node `npm run test:agent-language` | Yes | **No** |
| Node `npm run test:hard-graph` / `test:runtime` / `test:pen-tools` | Yes | **No** |
| Node `npm run check` (`tsc --noEmit`) | Yes | **No** (smoke uses `tsx` only) |
| `shared/**` path trigger | Tree exists | **No** |
| Catalog byte-lock tests | Yes (Node + Python) | **No** |
| Experts-specific test job | Packs loaded by smoke when present | No dedicated job; experts only affect path filter |
| Deploy / SSH / compose | Manual / deferred (`docs/v1-delivery.md` §8) | **No** |

This matches the “Current state” table in [`docs/specs/ci-cd.md`](../specs/ci-cd.md) §2 (draft map, 2026-07).

### 1.4 Docs that already claim “最小 CI”

- [`docs/v1-delivery.md`](../v1-delivery.md): V1 checklist marks **最小 CI：`.github/workflows/product-smoke.yml`** done; full CI/CD + deploy remains §8 “后续”.
- [`docs/specs/ci-cd.md`](../specs/ci-cd.md): product-smoke = FE build + node4 smoke; backend/catalog suites **not all wired**.

---

## 2. Phase A claim vs what exists in-repo

Source: [`docs/specs/ci-cd.md`](../specs/ci-cd.md) §3 Phase A + §4 CICD-LANG-*.

### 2.1 Phase A requirements (spec text)

1. Expand `product-smoke` (or split jobs) to run **deterministic** suites:
   - **Node:** at least `test:agent-language` (catalog lock + language inject seams)
   - **Platform:** `tests/test_agent_language.py` (+ other pure unit modules already green locally)
2. Path triggers include **`shared/**`** whenever cross-stack constants change.
3. Docs that claim “CI requires …” must match actual workflow steps (no aspirational harness rows).

Phase B (not first CD bar): curated Node suites (`test:hard-graph` / `test:runtime` / pen-tools), broader backend tests, optional extra FE typecheck.

Phase C: deploy automation after Phase A green (map #151 accelerates a **first** SSH CD on **current** smoke via Order-S — see §3).

### 2.2 Existence matrix (checked on main `3378b8c`)

| Phase A item | Exists in-repo today? | How to run locally | Wired in product-smoke? |
|--------------|----------------------|--------------------|-------------------------|
| Node `test:agent-language` | **Yes** — `node4/package.json` script | `cd node4 && npm run test:agent-language` | **No** |
| → `src/runtime/agent-language.test.ts` | **Yes** (catalog byte-identical vs shared + platform FE/BE copies; normalize/policy) | via script | **No** |
| → `src/runtime/subagent-language.test.ts` | **Yes** | via script | **No** |
| → `src/runtime/hard-graph-stage-prompts.test.ts` | **Yes** (also part of `test:hard-graph`) | via script | **No** |
| Platform `tests/test_agent_language.py` | **Yes** — unittest module | `cd platform/backend && python -m unittest tests.test_agent_language` (with package import path) | **No** |
| Catalog SoT + ship copies | **Yes** — `shared/agent-language-catalog.json` + three consumers (`shared/README.md`) | manual `cp` until CICD-LANG-2 | N/A (tests enforce post-hoc) |
| `shared/**` path filter | N/A | N/A | **No** |
| Other pure backend unit modules | **Yes** under `platform/backend/tests/` (9 `test_*.py`, ~1.5k lines; no DB service hints in imports sampled) | various unittest / plain assert modules | **No** |
| Doc/workflow honesty | Partial — `ci-cd.md` already describes the gap | N/A | Docs accurate that suites are **not** in CI |

### 2.3 Related suites that exist but are **Phase B** (not Phase A minimum)

| Script / area | Exists? | Phase |
|---------------|---------|-------|
| `node4` `test:hard-graph` | Yes (large multi-file chain) | B |
| `node4` `test:runtime` | Yes | B |
| `node4` `test:pen-tools` / `test:process-quality` / etc. | Yes | B / lab |
| Frontend typecheck alone | Already inside `npm run build` (`tsc -b`) | A-adjacent satisfied by current job; Phase B only if split needed |
| Backend broader suite with live services | Not required for Phase A pure units | B |

### 2.4 Deferred LANG hygiene (ci-cd.md §4)

| ID | Kind | In-repo status vs Phase A |
|----|------|---------------------------|
| **CICD-LANG-1** | Wire `test:agent-language` + `test_agent_language` + `shared/**` filters | **The** Phase A CI-wire item; suites exist, workflow does not |
| CICD-LANG-2 | Sync script SoT → ship copies | Not required to raise CD gate if lock tests run |
| CICD-LANG-3..6 | Types / copy hygiene / parity nits | Not CI blockers |

---

## 3. Recommended CD gate for first SSH deploy

### 3.1 Charting locks (map #151 — consulted, not edited)

- **Order-S:** three parallel tracks; **CD gates on whatever product-smoke is today**; Phase A and capability do **not** block first install.
- **CD-A:** GitHub Actions on green product-smoke → **SSH** to single server → pull/rebuild → restart.

### 3.2 Recommendation

**Reuse `product-smoke` as-is** as the required green gate for the first SSH deploy workflow.

| Option | Verdict | Why |
|--------|---------|-----|
| **A. Depend on current `product-smoke` (same two jobs)** | **Recommended** | Matches Order-S / CD-A; uses the only documented product CI; FE production build + Node smoke catch install-breaking syntax/import/pack load failures without waiting for Phase A. |
| **B. Named lighter subset** (e.g. FE-only or skip node4-smoke) | **Not recommended** | Weakens the only existing product gate for no bootstrap benefit; invents a second workflow name implementers must re-learn when Phase A lands. |
| **C. Require Phase A suites before first deploy** | **Not recommended for first install** | Contradicts Order-S; Phase A is a **parallel** honesty track that later raises the same gate. |
| **D. Duplicate jobs into deploy YAML without calling product-smoke** | Acceptable only as temporary if `workflow_call` is missing | Prefer **workflow_call** or “needs: product-smoke” / branch protection on the existing workflow so Phase A edits land in **one** place. |

### 3.3 Implementation notes for the future deploy ticket (not done here)

1. Gate deploy on **success of the existing workflow name** `product-smoke` (or extract its jobs into a reusable workflow that both PR CI and deploy call).
2. Deploy may need triggers beyond path filters (e.g. `workflow_dispatch`, tag, or `push` to `main` even when only compose/ops files change) — that is **deploy trigger** design, not a reason to shrink the smoke gate.
3. When Phase A expands `product-smoke.yml`, CD **inherits** the higher bar automatically if it depends on that workflow — no second promotion policy required for V1 beta.

---

## 4. Phase A follow-ups (prioritized checklist — no implementation)

Ordered for map #151 / `docs/specs/ci-cd.md` honesty. Each item is a future ticket-sized change.

### P0 — Close the documented honesty gap (CICD-LANG-1)

1. **[CI]** Add a Node job (or step on `node4-smoke` after `npm ci`) running `npm run test:agent-language` under `node4/` (Node 22, same cache as smoke).
2. **[CI]** Add a platform backend job running `tests/test_agent_language.py` (install backend deps from `platform/backend` — `uv`/`pip` per tree norms; no Postgres required for this module).
3. **[CI]** Extend `on.push` / `on.pull_request` path filters with **`shared/**`** (and keep workflow file path).
4. **[Docs]** After wiring, update `docs/specs/ci-cd.md` §2 “Current state” so it matches the workflow (Phase A partial or complete). Touch `docs/v1-delivery.md` only if the “最小 CI” claim needs a one-line accuracy note.

### P1 — Optional pure-unit expansion still inside Phase A spirit

5. **[CI]** Curate a **fast, no-service** backend unit set from existing `platform/backend/tests/` (e.g. pure helpers already present: case context / elapsed / engagement modules) — only after a local green run; do not pull in service-heavy tests without job isolation (Phase B).
6. **[CI]** Optional: `node4` `npm run check` (`tsc --noEmit`) as a cheap job; smoke does not replace compile of the full package.

### P2 — Hygiene adjacent to catalog (not CD blockers)

7. **CICD-LANG-2** — `scripts/sync-agent-language-catalog.sh` (or npm/make) SoT → three ship copies (`shared/README.md` already documents manual `cp`).
8. **CICD-LANG-3..6** — type tighten / default-seat copy / NodePage constant / vuln-session merge parity (per `ci-cd.md` §4 table).

### P3 — Explicitly **not** Phase A first-install gate (Phase B+)

9. Wire `test:hard-graph` / `test:runtime` / pen-tools (nightly or optional matrix).
10. Backend broader suite with real DB/MQ if needed, job-isolated.
11. Phase C image/compose promotion policy **after** Phase A green for non-beta production hardening (`ci-cd.md` §3 Phase C); first beta SSH CD remains Order-S / current smoke.

### Suggested ticket split (for map maintainers)

| Ticket | Scope |
|--------|--------|
| Phase A wire (LANG-1) | P0 items 1–4 |
| Phase A backend pure units | P1 item 5 (±6) |
| Catalog hygiene bundle | P2 items 7–8 |
| Phase B matrix | P3 items 9–10 |
| SSH CD workflow | Depend on product-smoke as-is; separate from Phase A |

---

## 5. Non-goals of this research

- Implementing workflow or deploy YAML changes.
- Editing map **#151** body (charting locks already sufficient).
- Claiming live-LLM language compliance or Hard Graph process-quality e2e in default PR CI (`ci-cd.md` §5).
- Scanning `research/` or `benchmarks/` in product CI.

---

## 6. Primary sources (absolute paths)

| Path | Role |
|------|------|
| `/mnt/d/Coding/my-ai-pen/.github/workflows/product-smoke.yml` | Actual CI jobs/steps/paths |
| `/mnt/d/Coding/my-ai-pen/.github/workflows/pen-sandbox.yml` | Unrelated sandbox image workflow |
| `/mnt/d/Coding/my-ai-pen/docs/specs/ci-cd.md` | Phase A/B/C + CICD-LANG-* backlog |
| `/mnt/d/Coding/my-ai-pen/docs/v1-delivery.md` | “最小 CI” done; deploy hardening deferred |
| `/mnt/d/Coding/my-ai-pen/node4/package.json` | `smoke`, `test:agent-language`, Phase B scripts |
| `/mnt/d/Coding/my-ai-pen/node4/src/node4-smoke.ts` | What node4-smoke job executes |
| `/mnt/d/Coding/my-ai-pen/node4/src/runtime/agent-language.test.ts` | Catalog lock + language suite entry |
| `/mnt/d/Coding/my-ai-pen/platform/frontend/package.json` | `build` = `tsc -b && vite build` |
| `/mnt/d/Coding/my-ai-pen/platform/backend/tests/test_agent_language.py` | Platform catalog / merge suite |
| `/mnt/d/Coding/my-ai-pen/platform/backend/tests/` | Other pure unit modules (Phase A optional) |
| `/mnt/d/Coding/my-ai-pen/shared/agent-language-catalog.json` | Cross-stack SoT |
| `/mnt/d/Coding/my-ai-pen/shared/README.md` | Manual re-copy until sync script |
| GitHub map **#151** Order-S / CD-A | First CD gates on current product-smoke |

---

## 7. Resolution

For ticket **#227**:

1. **Truth today:** two-job path-filtered smoke — FE production build + Node4 smoke script only.  
2. **Phase A suites:** named tests **exist** and already enforce catalog lockstep; **not** in GHA.  
3. **First SSH CD:** **reuse product-smoke as-is**; raise the bar later by expanding that same workflow (Order-S).  
4. **Follow-ups:** prioritized P0–P3 checklist above; no code in this resolution.
