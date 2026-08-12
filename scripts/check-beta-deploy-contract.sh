#!/usr/bin/env bash
# Seam 1 — deploy contract static check for Spec #231 (internal beta single-server).
# No VPS, Cloudflare, or live LLM required. Exit 0 only if locked assets match the contract.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "CONTRACT FAIL: $*" >&2
  exit 1
}

pass() {
  echo "OK: $*"
}

COMPOSE="$ROOT/platform/docker-compose.yml"
CADDY="$ROOT/deploy/beta/Caddyfile"
DEPLOY_SH="$ROOT/scripts/beta-deploy.sh"
FE_ENV="$ROOT/scripts/beta-fe-env.sh"
UNITS_DIR="$ROOT/deploy/beta/systemd"
SMOKE_WF="$ROOT/.github/workflows/product-smoke.yml"
DEPLOY_WF="$ROOT/.github/workflows/beta-deploy.yml"
RUNBOOK="$ROOT/docs/deploy/beta-bootstrap.md"
CICD_DOC="$ROOT/docs/specs/ci-cd.md"

[[ -f "$COMPOSE" ]] || fail "missing $COMPOSE"

for svc in db rabbitmq cloudflared caddy; do
  grep -qE "^[[:space:]]*${svc}:" "$COMPOSE" || fail "compose missing service: $svc"
done
pass "compose lists db rabbitmq cloudflared caddy"

# backend + caddy + cloudflared profile-gated (default up = db+mq only)
awk '
  /^[[:space:]]*backend:/ {inb=1; next}
  inb && /^[[:space:]]*[a-zA-Z0-9_-]+:/ && $0 !~ /^[[:space:]]{2,}/ {inb=0}
  inb {print}
' "$COMPOSE" | grep -q 'profiles:.*dev' || fail "backend must use profiles: [dev]"
pass "compose backend is profile-gated (dev)"

awk '
  /^[[:space:]]*caddy:/ {inb=1; next}
  inb && /^[[:space:]]*[a-zA-Z0-9_-]+:/ && $0 !~ /^[[:space:]]{2,}/ {inb=0}
  inb {print}
' "$COMPOSE" | grep -q 'profiles:.*beta' || fail "caddy must use profiles: [beta]"
pass "compose caddy is profile-gated (beta)"

awk '
  /^[[:space:]]*cloudflared:/ {inb=1; next}
  inb && /^[[:space:]]*[a-zA-Z0-9_-]+:/ && $0 !~ /^[[:space:]]{2,}/ {inb=0}
  inb {print}
' "$COMPOSE" | grep -q 'profiles:.*tunnel' || fail "cloudflared must use profiles: [tunnel]"
pass "compose cloudflared is profile-gated (tunnel)"

# Caddy uses host networking so reverse_proxy can reach 127.0.0.1:8000
awk '
  /^[[:space:]]*caddy:/ {inb=1; next}
  inb && /^[[:space:]]*[a-zA-Z0-9_-]+:/ && $0 !~ /^[[:space:]]{2,}/ {inb=0}
  inb {print}
' "$COMPOSE" | grep -q 'network_mode:.*host' || fail "caddy must use network_mode: host"
pass "compose caddy uses host network for loopback backend"

# Optional tunnel secret must not break bare `docker compose up` via :? expansion
if grep -qE '\$\{TUNNEL_TOKEN:\?' "$COMPOSE"; then
  fail "compose must not use \${TUNNEL_TOKEN:?} (breaks default up without token)"
fi
pass "compose does not require TUNNEL_TOKEN for non-tunnel up"

if grep -qE '["'\'']5432:5432' "$COMPOSE"; then
  grep -qE '127\.0\.0\.1:5432' "$COMPOSE" || fail "postgres port must bind 127.0.0.1"
fi
if grep -qE '["'\'']5672:5672' "$COMPOSE"; then
  grep -qE '127\.0\.0\.1:5672' "$COMPOSE" || fail "rabbitmq AMQP port must bind 127.0.0.1"
fi
pass "compose publishes DB/MQ on loopback when ports are mapped"

[[ -f "$CADDY" ]] || fail "missing Caddyfile"
grep -qE 'http://127\.0\.0\.1:8080|127\.0\.0\.1:8080' "$CADDY" || fail "Caddyfile must bind 127.0.0.1:8080 (not all interfaces)"
grep -qE 'auto_https off|http://127\.0\.0\.1:8080' "$CADDY" || fail "Caddyfile must disable auto HTTPS on loopback HTTP origin"
grep -qE 'handle /api' "$CADDY" || fail "Caddyfile must route /api"
grep -qE 'handle /ws' "$CADDY" || fail "Caddyfile must route /ws"
grep -qiE 'file_server|try_files' "$CADDY" || fail "Caddyfile must serve static UI"
pass "Caddyfile has /api, /ws, static UI intent, loopback bind"

[[ -f "$FE_ENV" ]] || fail "missing scripts/beta-fe-env.sh"
[[ -f "$DEPLOY_SH" ]] || fail "missing scripts/beta-deploy.sh"
[[ -x "$DEPLOY_SH" ]] || fail "scripts/beta-deploy.sh must be executable"

for needle in \
  'git fetch' \
  'docker compose' \
  'uv sync' \
  'alembic upgrade' \
  'npm ci' \
  'npm run build' \
  'systemctl restart' \
  'beta-fe-env.sh' \
  'DEPLOY_SHA' \
  'profile beta' \
  '/api/health' \
  'docker pull' \
  'PEN_SANDBOX_IMAGE'
do
  grep -qF -- "$needle" "$DEPLOY_SH" || fail "beta-deploy.sh missing: $needle"
done
grep -qE 'DEPLOY_BRANCH:-main|origin/\$\{BRANCH\}' "$DEPLOY_SH" \
  || fail "beta-deploy.sh must default branch to main"
# CD host may have emergency hotfixes — pin must hard-reset tracked dirt
grep -qE 'git reset --hard' "$DEPLOY_SH" || fail "beta-deploy.sh must git reset --hard when pinning DEPLOY_SHA"
# Hard-fail path for missing public origin (via beta-fe-env)
grep -q 'BETA_PUBLIC_ORIGIN' "$FE_ENV" || fail "beta-fe-env.sh must require BETA_PUBLIC_ORIGIN"
grep -q 'ERROR:' "$FE_ENV" || fail "beta-fe-env.sh must fail closed without origin"
pass "beta-deploy.sh + beta-fe-env hard-require same-origin FE build + hard-reset pin"

grep -qE 'my-ai-pen-backend' "$DEPLOY_SH" || fail "deploy must restart my-ai-pen-backend"
grep -qE 'my-ai-pen-node4' "$DEPLOY_SH" || fail "deploy must restart my-ai-pen-node4"
pass "deploy restarts host units"

if grep -vE '^[[:space:]]*#' "$DEPLOY_SH" | grep -qE 'python -m app\.db\.seed|seed\.py'; then
  fail "beta-deploy.sh must not run DB seed on every deploy"
fi
pass "beta-deploy.sh does not seed on every run"

[[ -f "$UNITS_DIR/my-ai-pen-backend.service" ]] || fail "missing backend unit"
[[ -f "$UNITS_DIR/my-ai-pen-node4.service" ]] || fail "missing node4 unit"
if grep -q '\-\-reload' "$UNITS_DIR/my-ai-pen-backend.service"; then
  fail "backend unit must not use --reload"
fi
grep -q 'uvicorn' "$UNITS_DIR/my-ai-pen-backend.service" || fail "backend unit must run uvicorn"
grep -qE 'tsx|node4' "$UNITS_DIR/my-ai-pen-node4.service" || fail "node4 unit must run tsx/node4"
pass "systemd unit templates present without reload"

[[ -f "$SMOKE_WF" ]] || fail "missing product-smoke workflow"
[[ -f "$DEPLOY_WF" ]] || fail "missing beta-deploy workflow"
grep -q 'workflow_run' "$DEPLOY_WF" || fail "beta-deploy must use workflow_run"
grep -q 'product-smoke' "$DEPLOY_WF" || fail "beta-deploy must reference product-smoke"
grep -q 'conclusion' "$DEPLOY_WF" || fail "beta-deploy must gate on workflow conclusion"
grep -q 'head_sha\|DEPLOY_SHA' "$DEPLOY_WF" || fail "beta-deploy must pass smoke head_sha / DEPLOY_SHA"
grep -qiE 'ssh|appleboy' "$DEPLOY_WF" || fail "beta-deploy must SSH"
grep -qE 'JWT_SECRET|TUNNEL_TOKEN|LLM_API_KEY' "$DEPLOY_WF" \
  && fail "beta-deploy workflow must not reference business secrets" || true
pass "beta-deploy workflow: smoke gate + SHA pin + SSH, no business secrets"

grep -q 'check-beta-deploy-contract' "$SMOKE_WF" "$DEPLOY_WF" \
  || fail "CI must invoke check-beta-deploy-contract.sh"
# Phase A: exact command needles (not job-name-only / loose alternates)
grep -qF 'npm run test:ci-pr' "$SMOKE_WF" || fail "product-smoke must run: npm run test:ci-pr"
grep -qF 'uv run pytest' "$SMOKE_WF" || fail "product-smoke must run: uv run pytest"
grep -qF 'npm run test:unit' "$SMOKE_WF" || fail "product-smoke must run: npm run test:unit"
# product-deep edits must re-run Seam-1
grep -qF 'product-deep.yml' "$SMOKE_WF" \
  || fail "product-smoke paths must include .github/workflows/product-deep.yml"
pass "CI invokes deploy contract check + Phase A command needles"

DEEP_WF="$ROOT/.github/workflows/product-deep.yml"
[[ -f "$DEEP_WF" ]] || fail "missing product-deep workflow (Phase B scaffold)"
grep -q 'workflow_dispatch' "$DEEP_WF" || fail "product-deep must support workflow_dispatch"
# Fail closed: no automatic triggers (dispatch-only invariant for #240)
if grep -E '^[[:space:]]+(push|pull_request|schedule|workflow_run):' "$DEEP_WF" >/dev/null; then
  fail "product-deep must not declare push/pull_request/schedule/workflow_run (dispatch-only)"
fi
# Deep lane must never gate CD
if grep -q 'product-deep' "$DEPLOY_WF"; then
  fail "beta-deploy must not reference product-deep (deep CI must not gate CD)"
fi
# No business secrets in deep workflow (same policy as deploy workflow)
if grep -qE 'JWT_SECRET|TUNNEL_TOKEN|LLM_API_KEY|secrets\.' "$DEEP_WF"; then
  fail "product-deep must not reference business secrets / secrets.* (LLM reserved off)"
fi
pass "product-deep is dispatch-only scaffold and does not gate beta-deploy"

[[ -f "$RUNBOOK" ]] || fail "missing docs/deploy/beta-bootstrap.md"
grep -qiE 'Cloudflare|Access|TUNNEL' "$RUNBOOK" || fail "runbook must cover Tunnel/Access"
grep -qiE 'VITE_|beta-fe-env|same-origin' "$RUNBOOK" || fail "runbook must document VITE_ / beta-fe-env"
grep -qiE 'admin|JWT|secret' "$RUNBOOK" || fail "runbook must cover secrets hard gate"
grep -qiE 'AI-assisted|human review|capability|honest' "$RUNBOOK" "$CICD_DOC" \
  || fail "docs must state honest capability bar"
pass "operator docs cover bootstrap, FE origin, secrets, capability honesty"

echo ""
echo "All beta deploy contracts passed."
exit 0
