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
UNITS_DIR="$ROOT/deploy/beta/systemd"
SMOKE_WF="$ROOT/.github/workflows/product-smoke.yml"
DEPLOY_WF="$ROOT/.github/workflows/beta-deploy.yml"
RUNBOOK="$ROOT/docs/deploy/beta-bootstrap.md"
CICD_DOC="$ROOT/docs/specs/ci-cd.md"

# --- compose: required beta services; backend not the default API for CD ---
[[ -f "$COMPOSE" ]] || fail "missing $COMPOSE"

for svc in db rabbitmq cloudflared caddy; do
  grep -qE "^[[:space:]]*${svc}:" "$COMPOSE" || fail "compose missing service: $svc"
done
pass "compose lists db rabbitmq cloudflared caddy"

# Backend may exist for local dev but must be under a non-default profile (not CD API)
if grep -qE "^[[:space:]]*backend:" "$COMPOSE"; then
  # Between backend: and next top-level key or end, require profiles including dev
  awk '
    /^[[:space:]]*backend:/ {inb=1; next}
    inb && /^[[:space:]]*[a-zA-Z0-9_-]+:/ && $0 !~ /^[[:space:]]{2,}/ {inb=0}
    inb {print}
  ' "$COMPOSE" | grep -q "profiles:" || fail "compose backend must use profiles (dev-only), not default beta stack"
  pass "compose backend is profile-gated (dev)"
else
  pass "compose has no backend service (host process only)"
fi

# DB/MQ ports should prefer loopback bind when published (127.0.0.1)
if grep -qE '["'\'']5432:5432' "$COMPOSE"; then
  grep -qE '127\.0\.0\.1:5432' "$COMPOSE" || fail "postgres port must bind 127.0.0.1, not 0.0.0.0"
fi
if grep -qE '["'\'']5672:5672' "$COMPOSE"; then
  grep -qE '127\.0\.0\.1:5672' "$COMPOSE" || fail "rabbitmq AMQP port must bind 127.0.0.1"
fi
pass "compose publishes DB/MQ on loopback when ports are mapped"

# --- Caddy routes ---
[[ -f "$CADDY" ]] || fail "missing Caddyfile at deploy/beta/Caddyfile"
grep -qE 'handle[[:space:]]+/api|reverse_proxy.*/api|path /api' "$CADDY" \
  || grep -qiE 'handle /api|handle_path /api|/api\*' "$CADDY" \
  || fail "Caddyfile must route /api to backend"
grep -qE '/ws|handle /ws' "$CADDY" || fail "Caddyfile must route /ws for WebSocket"
grep -qiE 'file_server|root \*|try_files' "$CADDY" || fail "Caddyfile must serve frontend static root"
pass "Caddyfile has /api, /ws, static UI intent"

# --- host deploy script order ---
[[ -f "$DEPLOY_SH" ]] || fail "missing scripts/beta-deploy.sh"
[[ -x "$DEPLOY_SH" ]] || fail "scripts/beta-deploy.sh must be executable"

for needle in \
  'git fetch' \
  'git reset' \
  'docker compose' \
  'uv sync' \
  'alembic upgrade' \
  'npm ci' \
  'npm run build' \
  'systemctl restart'
do
  grep -qF "$needle" "$DEPLOY_SH" || fail "beta-deploy.sh missing step fragment: $needle"
done
# Default deploy branch is main (Spec #231)
grep -qE 'origin/\$\{BRANCH\}|origin/main|DEPLOY_BRANCH:-main' "$DEPLOY_SH" \
  || fail "beta-deploy.sh must reset to origin/main (or BRANCH default main)"
pass "beta-deploy.sh encodes git/compose/uv/alembic/npm/systemctl steps"

# Must restart both product host units
grep -qE 'my-ai-pen-backend' "$DEPLOY_SH" || fail "deploy must restart my-ai-pen-backend"
grep -qE 'my-ai-pen-node4' "$DEPLOY_SH" || fail "deploy must restart my-ai-pen-node4"
pass "deploy restarts my-ai-pen-backend and my-ai-pen-node4"

# Must not seed on every CD (allow comments about not seeding)
if grep -vE '^[[:space:]]*#' "$DEPLOY_SH" | grep -qE 'python -m app\.db\.seed|seed\.py'; then
  fail "beta-deploy.sh must not run DB seed on every deploy"
fi
pass "beta-deploy.sh does not seed on every run"

# Same-origin FE build env
grep -qE 'VITE_BACKEND_URL|VITE_WS_URL|BETA_PUBLIC_ORIGIN' "$DEPLOY_SH" \
  || fail "deploy must set same-origin FE build env (VITE_* or BETA_PUBLIC_ORIGIN)"
pass "deploy sets same-origin frontend build env"

# --- systemd unit templates ---
[[ -f "$UNITS_DIR/my-ai-pen-backend.service" ]] || fail "missing systemd unit my-ai-pen-backend.service"
[[ -f "$UNITS_DIR/my-ai-pen-node4.service" ]] || fail "missing systemd unit my-ai-pen-node4.service"
grep -q 'uvicorn' "$UNITS_DIR/my-ai-pen-backend.service" || fail "backend unit must run uvicorn"
grep -qv '\-\-reload' "$UNITS_DIR/my-ai-pen-backend.service" || true
if grep -q '\-\-reload' "$UNITS_DIR/my-ai-pen-backend.service"; then
  fail "backend unit must not use --reload"
fi
grep -qE 'tsx|node4' "$UNITS_DIR/my-ai-pen-node4.service" || fail "node4 unit must run node4 entry"
pass "systemd unit templates present without reload"

# --- CD workflow gated on product-smoke ---
[[ -f "$SMOKE_WF" ]] || fail "missing product-smoke workflow"
[[ -f "$DEPLOY_WF" ]] || fail "missing beta-deploy workflow"

grep -qE 'product-smoke|workflow_run' "$DEPLOY_WF" || fail "beta-deploy must reference product-smoke or workflow_run"
grep -qiE 'ssh|appleboy|SSH' "$DEPLOY_WF" || fail "beta-deploy workflow must SSH to host"
pass "beta-deploy workflow present with smoke gate + SSH intent"

# Path filters should cover deploy assets somewhere in CI
if ! grep -q 'deploy/' "$SMOKE_WF" && ! grep -q 'scripts/beta-deploy' "$SMOKE_WF" && ! grep -q 'check-beta-deploy' "$SMOKE_WF"; then
  # contract job may live in beta-deploy or smoke — accept either
  if ! grep -q 'check-beta-deploy-contract' "$DEPLOY_WF" && ! grep -q 'check-beta-deploy-contract' "$SMOKE_WF"; then
    fail "CI must run scripts/check-beta-deploy-contract.sh (smoke or deploy workflow)"
  fi
fi
grep -q 'check-beta-deploy-contract' "$SMOKE_WF" "$DEPLOY_WF" || fail "CI must invoke check-beta-deploy-contract.sh"
pass "CI invokes deploy contract check"

# --- docs ---
[[ -f "$RUNBOOK" ]] || fail "missing docs/deploy/beta-bootstrap.md"
grep -qiE 'Cloudflare|Access|TUNNEL' "$RUNBOOK" || fail "runbook must cover Cloudflare Tunnel/Access"
grep -qiE 'admin|JWT|secret' "$RUNBOOK" || fail "runbook must cover secrets / admin hard gate"
grep -qiE 'AI-assisted|human review|capability|honest' "$RUNBOOK" "$CICD_DOC" \
  || fail "docs must state honest capability bar"
pass "operator docs cover bootstrap, secrets, capability honesty"

echo ""
echo "All beta deploy contracts passed."
exit 0
