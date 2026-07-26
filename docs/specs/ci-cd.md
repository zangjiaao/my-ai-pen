# Spec: CI/CD (product path)

> **Status:** draft map / backlog — not V1 delivery gate.  
> **Owner:** platform + Node4 maintainers.  
> **Related:** [v1-delivery §8](../v1-delivery.md) (部署硬化), [harness](harness.md) (test seams), Wayfinder map (GitHub `wayfinder:map` for CI/CD).

---

## 1. Intent

Automate **product-path** verification and (later) deploy for:

- `platform/` (backend + frontend)
- `node4/`
- `experts/`
- `shared/` (cross-stack constants, e.g. agent-language catalog)
- pen-sandbox / compose as needed for release

**Not** in scope for this map: full enterprise multi-env mesh, multi-tenant deploy, or scanning frozen `research/` / `benchmarks/`.

---

## 2. Current state (as of 2026-07)

| Piece | Today |
|-------|--------|
| GitHub Actions | `.github/workflows/product-smoke.yml` — FE `npm run build`, node4 smoke, limited path filters |
| Path filters | `platform/**`, `node4/**`, `experts/**`, workflow file only — **`shared/**` not covered** |
| Backend unit tests | Present under `platform/backend/tests/` — **not all wired into product-smoke** |
| Node focused suites | e.g. `npm run test:agent-language`, `test:hard-graph` — **local / agent-run; not full CI matrix** |
| Deploy | Manual / compose; V1 explicitly deferred production compose hardening |
| Catalog locks | Byte-identical tests for `shared/agent-language-catalog.json` ship copies exist in Node + Python tests, but **product-smoke does not run them** |

V1 checklist marks “最小 CI” done; **full CI/CD + deploy** remains §8 “后续”.

---

## 3. Target shape (when this map is executed)

Phased — implement as separate tickets under the CI/CD Wayfinder map, not one mega-PR.

### Phase A — Truthful product smoke (tests that exist, always run)

1. Expand `product-smoke` (or split jobs) to run **deterministic** suites:
   - Node: at least `test:agent-language` (catalog lock + language inject seams)
   - Platform: `tests/test_agent_language.py` (+ other pure unit modules already green locally)
2. Path triggers include **`shared/**`** whenever cross-stack constants change.
3. Docs that claim “CI requires …” must match actual workflow steps (no aspirational harness rows).

### Phase B — Deeper product gates (optional matrix)

1. Curated Node suites: `test:hard-graph` / `test:runtime` / pen-tools as jobs or nightly.
2. Backend broader unittest/pytest with service deps only if job-isolated and fast.
3. Frontend typecheck (`tsc --noEmit`) as a job if build alone is insufficient.

### Phase C — Deploy automation

1. Production-oriented compose / image build without dev reload.
2. Promote artifacts only after Phase A green.
3. Secrets / env contract documented; no credentials in repo.

Out of scope until product needs it: multi-region, canary, full E2E against live labs in default PR CI.

---

## 4. Deferred follow-ups from agent_language review (#134–#138)

These are **intentionally not fixed** in the language epic. Track them here for the CI/CD (or adjacent small hygiene) pass:

| ID | Kind | Item | Why defer |
|----|------|------|-----------|
| CICD-LANG-1 | CI wire | Run `node4` `test:agent-language` + backend `test_agent_language` in product-smoke; include `shared/**` in path filters | Needs workflow design, not product logic |
| CICD-LANG-2 | Tooling | `scripts/sync-agent-language-catalog.sh` (or npm/make target) SoT → three ship copies | Ceremony; lock tests already catch drift post-hoc |
| CICD-LANG-3 | Types | Tighten `TaskEnvelope.agentLanguage` to registry wire type; catalog-driven or documented TS unions | Type hygiene; runtime already normalizes |
| CICD-LANG-4 | Hygiene | `default` seat mission: drop hardcoded language enum list | One-line copy; not a CI blocker |
| CICD-LANG-5 | Hygiene | NodePage use `DEFAULT_AGENT_LANGUAGE` constant | Nit |
| CICD-LANG-6 | Parity | Vuln-session dispatch use `merge_worker_limits_into_message` like chat task_assign/steer | Behaviour already carries language inside `worker_limits` |

When Phase A lands, **CICD-LANG-1** should be closed as part of that work. LANG-2..6 can be a single “catalog hygiene” child ticket or separate nits.

---

## 5. Non-goals

- Guaranteeing model language compliance via CI (no live-LLM language asserts).
- Replacing local AFK agent test loops for exploratory Graph work.
- CI for frozen `research/` / `benchmarks/`.
- Blocking product merges on full Hard Graph process-quality e2e until jobs are stable and fast enough.

---

## 6. Success criteria (map complete)

1. PR touching product paths runs a **documented, green** smoke that matches harness/PRD claims about CI.
2. Catalog (and similar `shared/`) constants cannot land with divergent ship copies without a red job.
3. Deploy path (when built) is one documented command/workflow after smoke green.
4. Deferred LANG-* items either closed or explicitly re-scoped; none silently re-open as “language is broken.”

---

## 7. Related paths

| Path | Role |
|------|------|
| `.github/workflows/product-smoke.yml` | Current minimal CI |
| `shared/agent-language-catalog.json` | Cross-stack constant SoT example |
| `shared/README.md` | Manual re-copy instructions until sync script |
| `node4/package.json` `test:agent-language` | Language / catalog lock suite |
| `platform/backend/tests/test_agent_language.py` | Platform catalog / merge suite |
