# Spec: CI/CD (product path + internal beta deploy)

> **Status:** living contract for product smoke + single-host beta deploy (Spec #231).  
> **Owner:** platform + Node4 maintainers.  
> **Related:** [v1-delivery](../v1-delivery.md), [beta-bootstrap](../deploy/beta-bootstrap.md), Wayfinder map #151.

---

## 1. Intent

Automate **product-path** verification and **single-host internal beta** deploy for:

- `platform/` (backend + frontend)
- `node4/`
- `experts/`
- `deploy/beta/` (Caddy, systemd templates)
- `scripts/beta-deploy.sh`, `scripts/check-beta-deploy-contract.sh`

**Not** in scope: full enterprise multi-env mesh, multi-tenant deploy, scanning frozen `research/` / `benchmarks/`, Workers/Vercel platform backend.

---

## 2. Current shape (2026-07)

| Piece | Behavior |
|-------|----------|
| **product-smoke** | FE `npm run build`; node4 smoke; **beta deploy contract** script |
| Path filters | `platform/**`, `node4/**`, `experts/**`, `deploy/**`, deploy scripts, workflows |
| **beta-deploy** | `workflow_run` after successful product-smoke on `main` **push** → SSH → `scripts/beta-deploy.sh` |
| Host topology | Docker: db, rabbitmq, caddy, cloudflared; systemd: backend + node4; FE dist via Caddy |
| Secrets | GH: SSH only; host: JWT/DB/MQ/LLM/NODE_TOKEN/TUNNEL; CF dashboard: Access + Tunnel |

### Capability honesty (beta copy)

AI-assisted testing workbench with **human review**. Not unattended full-coverage red team. Dig path: Node4 + pentest expert → findings ledger. Install ≠ guaranteed dig quality on every target.

---

## 3. Phases

### Phase A — Truthful product smoke (optional follow-up; not first-install blocker)

Wire existing deterministic suites (e.g. agent-language catalog locks) into CI when ready. Path filters for `shared/**` when those suites land.

### Phase B — Deeper gates (later)

Hard-graph / runtime matrix or nightly; broader backend unit jobs.

### Phase C — Deploy (this ship)

1. Production-oriented compose (no reload backend as default API).
2. Promote only after product-smoke green.
3. Secrets contract documented; no business credentials in repo or GH except deploy SSH.

---

## 4. Deploy contract check (Seam 1)

```bash
bash scripts/check-beta-deploy-contract.sh
```

Asserts compose services, Caddy routes, deploy script steps, systemd units, CD workflow structure, and operator docs—without a real VPS.

---

## 5. Success criteria

1. PR touching product/deploy paths runs documented green smoke including contract check.
2. After `main` push smoke green, beta host can be updated via SSH deploy script.
3. Operators have bootstrap + secrets + capability notes in `docs/deploy/beta-bootstrap.md`.
4. Phase A/B items either closed later or explicitly deferred—not silent “CI is broken.”

---

## 6. Related paths

| Path | Role |
|------|------|
| `.github/workflows/product-smoke.yml` | Smoke + contract |
| `.github/workflows/beta-deploy.yml` | SSH CD |
| `platform/docker-compose.yml` | db/mq/caddy/cloudflared (+ profile `dev` backend) |
| `deploy/beta/Caddyfile` | Same-origin FE + `/api` + `/ws` |
| `scripts/beta-deploy.sh` | Host deploy entrypoint |
| `docs/deploy/beta-bootstrap.md` | Operator runbook |
