# Internal beta bootstrap (single host)

Operator runbook for **Spec #231** / Wayfinder map product CI/CD + internal beta single-server ship.  
Topology: one Linux host; Docker = Postgres, RabbitMQ, Caddy, cloudflared; host systemd = platform backend + Node4; FE static via Caddy.

## Capability honesty

This product is an **AI-assisted** security testing workbench. Operators and internal testers should expect:

- Dig path: login → online **Node4** → **pentest** expert (not default-only booking) → tools / pen-sandbox → findings into the vulnerability ledger.
- **Human review** of findings is required.
- **Not** unattended full red-team coverage, not a scanner replacement, not a full-coverage SLA.
- Some V1 acceptance rows still need environment 联调; install success ≠ proven dig quality on every target.

## Host layout

| Path | Purpose |
|------|---------|
| `/opt/my-ai-pen` | Git checkout (may symlink onto data disk) |
| `/data/docker` | Docker `data-root` (recommended when root disk is small) |
| `platform/backend/.env` | Backend secrets (host only) |
| `node4/.env` | Node token + model keys (host only) |
| `platform/.env` | Compose vars: DB/MQ passwords, `TUNNEL_TOKEN` |
| `/etc/my-ai-pen/beta.env` | **Required for public beta FE build:** `BETA_PUBLIC_ORIGIN=https://your.domain` |

## Compose profiles

| Command | Services |
|---------|----------|
| `docker compose up -d` | **db + rabbitmq** only (safe local default) |
| `docker compose --profile beta up -d` | + **caddy** (edge reverse proxy on `127.0.0.1:8080`) |
| `docker compose --profile tunnel up -d` | + **cloudflared** (needs `TUNNEL_TOKEN`) |
| `docker compose --profile dev up -d` | + **backend** container with reload (local only; beta uses systemd) |

## One-time bootstrap checklist

1. **OS + base** — Debian 12 / Alma 9 etc.; user `deploy` with sudo + docker; SSH key for ops and later CD.
2. **Docker Engine + Compose v2** — set `data-root` on large disk if needed.
3. **Node.js ≥ 22**, **uv** (Python), **git**.
4. **Clone** repo to `/opt/my-ai-pen` as `deploy` (HTTPS or deploy key).
5. **Secrets (hard gate before any public Tunnel traffic)**  
   - Strong `JWT_SECRET` (≥32 chars)  
   - Strong Postgres + RabbitMQ passwords (not lab `postgres`/`guest`)  
   - Admin: seed once then **change** password from lab default `admin@pentest.local` / `admin123`  
   - Node LLM API keys; after first UI register, set `NODE_TOKEN`  
   - `TUNNEL_TOKEN` from Cloudflare Zero Trust (**host only**, never git / never chat long-term — rotate if exposed)  
   - Bind DB/MQ to **127.0.0.1** only (compose default in-repo)
6. **Cloudflare**  
   - Create Tunnel → public hostname → **`http://127.0.0.1:8080`** (Caddy)  
   - **Access** application allowlist (emails / IdP) on that hostname  
   - Copy tunnel token to host `platform/.env` as `TUNNEL_TOKEN=...` (mode `600`)
7. **Public origin for FE build** in `/etc/my-ai-pen/beta.env`:
   ```bash
   BETA_PUBLIC_ORIGIN=https://YOUR_PUBLIC_HOSTNAME
   ```
   Vite only inlines `VITE_*`. Always map via:
   ```bash
   source /opt/my-ai-pen/scripts/beta-fe-env.sh
   # exports VITE_BACKEND_URL + VITE_WS_URL from BETA_PUBLIC_ORIGIN
   ```
8. **Install systemd units** from `deploy/beta/systemd/*.service` into `/etc/systemd/system/`, `daemon-reload`, `enable`.
9. **First start (manual)**  
   ```bash
   cd /opt/my-ai-pen/platform
   # platform/.env must include strong DB/MQ passwords + TUNNEL_TOKEN
   docker compose up -d db rabbitmq
   docker compose --profile beta up -d caddy
   docker compose --profile tunnel up -d cloudflared

   cd /opt/my-ai-pen/platform/backend && uv sync && uv run alembic upgrade head
   # once only: uv run python -m app.db.seed   # then change admin password

   source /etc/my-ai-pen/beta.env
   source /opt/my-ai-pen/scripts/beta-fe-env.sh
   cd /opt/my-ai-pen/platform/frontend && npm ci && npm run build

   cd /opt/my-ai-pen/node4 && npm ci
   sudo systemctl enable --now my-ai-pen-backend my-ai-pen-node4
   curl -fsS http://127.0.0.1:8000/api/health
   curl -fsS http://127.0.0.1:8080/api/health
   ```
10. **Register Node4** in platform UI → put token in `node4/.env` → restart node4 unit.
11. **GitHub Actions CD** (optional after first green path)  
    - Secrets: `BETA_SSH_HOST`, `BETA_SSH_PORT`, `BETA_SSH_USER`, `BETA_SSH_KEY` only  
    - Business secrets stay on host  
    - `beta-deploy` runs after **product-smoke** succeeds on `main` **push**, pins `DEPLOY_SHA` to the smoke commit  
    - Job is skipped when `BETA_SSH_HOST` is unset

## Multi-user posture

- **Cloudflare Access** controls who reaches the site.  
- Use **1–2 admin** app accounts; no user-management UI in this ship.  
- Do **not** claim `member` cannot manage nodes (API is not fully role-gated today).

## Rotation

Event-driven only (leak, staff leave Access list, host rebuild, token pasted into chat). Edit host env → restart units/compose. No mandatory periodic rotation for beta.

## Related

- Spec: GitHub issue **#231**  
- Living CI/CD notes: `docs/specs/ci-cd.md`  
- Contract check: `scripts/check-beta-deploy-contract.sh`  
- Deploy script: `scripts/beta-deploy.sh`  
- FE env helper: `scripts/beta-fe-env.sh`
