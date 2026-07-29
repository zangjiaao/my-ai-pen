# Spec: CI/CD (product path + internal beta deploy)

> **Status:** living contract for product smoke + single-host beta deploy (Spec #231) and CI Phase A/B (#239 / #240).  
> **Owner:** platform + Node4 maintainers.  
> **Related:** [v1-delivery](../v1-delivery.md), [beta-bootstrap](../deploy/beta-bootstrap.md), Wayfinder map #151 (closed).

---

## 1. Intent

Automate **product-path** verification and **single-host internal beta** deploy for:

- `platform/` (backend + frontend)
- `node4/`
- `experts/`
- `shared/` (catalog locks used by platform + node4)
- `deploy/beta/` (Caddy, systemd templates)
- `scripts/beta-deploy.sh`, `scripts/check-beta-deploy-contract.sh`

**Not** in scope: full enterprise multi-env mesh, multi-tenant deploy, scanning frozen `research/` / `benchmarks/`, Workers/Vercel platform backend.

---

## 2. Current shape

| Piece | Behavior |
|-------|----------|
| **product-smoke** | Seam-1 contract; FE unit + production build; **backend pytest**; Node4 **test:ci-pr** allowlist + smoke entrypoint |
| Path filters | `platform/**`, `node4/**`, `experts/**`, `shared/**`, `deploy/**`, deploy scripts, workflows, ci-cd doc |
| **beta-deploy** | `workflow_run` after successful product-smoke on `main` **push** only → SSH → `scripts/beta-deploy.sh` (pin `DEPLOY_SHA`, `git reset --hard`) |
| **product-deep** | Phase B: **`workflow_dispatch` only** — heavy deterministic suites; **does not** gate merge or beta-deploy |
| **pen-sandbox** | Independent image build/push on `sandbox/pen-sandbox/**` — not part of product-smoke/CD |
| Host topology | Docker: db, rabbitmq, caddy, cloudflared; systemd: backend + node4; FE dist via Caddy |
| Secrets | GH deploy: SSH only; host: JWT/DB/MQ/LLM/NODE_TOKEN/TUNNEL; CF: Access + Tunnel. product-smoke has **no** business secrets |

### Capability honesty (beta copy)

AI-assisted testing workbench with **human review**. Not unattended full-coverage red team. Dig path: Node4 + pentest expert → findings ledger. Install ≠ guaranteed dig quality on every target. CI green ≠ dig quality on every target.

---

## 3. Phases

### Phase A — Truthful product smoke (#239) — **shipped in product-smoke**

PR / main path gate (no LLM, no beta VPS):

| Job | What |
|-----|------|
| `beta-deploy-contract` | `scripts/check-beta-deploy-contract.sh` |
| `frontend-build` | `npm run test:unit` then `npm run build` |
| `backend-unit` | `uv sync --group dev` + `uv run pytest tests/` |
| `node4-smoke` | `npm run test:ci-pr` then `node4-smoke` with `CI=1` |

**Allowlist policy (`node4` `test:ci-pr`):** deterministic first-party suites only (agent-language, graph/subagent booking, case-context, findings report, pack capability, hard-graph definition, engagement close-out, book completeness, envelopes, finding severity, reconcile-offers).  
**Excluded from Phase A:** full `test:hard-graph`, full `test:process-quality`, pen-tools Docker, live digs, scorecards, LLM.

Local mirror:

```bash
bash scripts/check-beta-deploy-contract.sh
(cd platform/frontend && npm ci && npm run test:unit && npm run build)
(cd platform/backend && uv sync --group dev && PYTHONPATH=. uv run pytest tests/ -q)
(cd node4 && npm ci && npm run test:ci-pr && CI=1 npm run smoke)
```

### Phase B — Deeper gates (#240) — **dispatch scaffold**

Workflow: **`product-deep`** (`workflow_dispatch`).

| Input `suite` | Runs |
|---------------|------|
| `node4-process-quality` | `npm run test:process-quality` |
| `node4-hard-graph` | `npm run test:hard-graph` |
| `node4-all-heavy` | both of the above |
| `backend-unit` | same pytest as Phase A (convenience) |
| `all-deterministic` | heavy Node4 + backend |

- `allow_llm` reserved: **must stay false** until a suite and Environment secrets are explicitly added (currently fails closed if true).
- **Not** a required status check; **not** a `workflow_run` predecessor of beta-deploy.
- Schedule (nightly): optional follow-up after manual green streak — not enabled yet.

### Phase C — Deploy (shipped, Spec #231)

1. Production-oriented compose (no reload backend as default API).
2. Promote only after product-smoke green on main push.
3. Secrets contract documented; no business credentials in repo or GH except deploy SSH.

---

## 4. Deploy contract check (Seam 1)

```bash
bash scripts/check-beta-deploy-contract.sh
```

Asserts compose services, Caddy routes, deploy script steps (including hard-reset pin), systemd units, CD workflow structure, Phase A job needles, product-deep non-gating, and operator docs—without a real VPS.

---

## 5. Success criteria

1. PR touching product/deploy paths runs documented green smoke including contract check + Phase A suites.
2. After `main` push smoke green, beta host can be updated via SSH deploy script.
3. Operators have bootstrap + secrets + capability notes in `docs/deploy/beta-bootstrap.md`.
4. Phase A is allowlisted in product-smoke; Phase B is dispatch-only and does not block CD.
5. No silent “CI is broken” for deferred nightly schedule — document when added.

---

## 6. Related paths

| Path | Role |
|------|------|
| `.github/workflows/product-smoke.yml` | Phase A gate + contract |
| `.github/workflows/product-deep.yml` | Phase B dispatch deep |
| `.github/workflows/beta-deploy.yml` | SSH CD |
| `.github/workflows/pen-sandbox.yml` | Sandbox image (independent) |
| `platform/docker-compose.yml` | db/mq/caddy/cloudflared (+ profile `dev` backend) |
| `deploy/beta/Caddyfile` | Same-origin FE + `/api` + `/ws` |
| `scripts/beta-deploy.sh` | Host deploy entrypoint |
| `docs/deploy/beta-bootstrap.md` | Operator runbook |
