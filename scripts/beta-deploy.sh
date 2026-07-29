#!/usr/bin/env bash
# Host deploy entrypoint for internal beta (Spec #231 / map #151).
# Invoked by GitHub Actions SSH or manually as deploy@host.
# Failure policy: any step non-zero exits — no automatic git/DB rollback.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/my-ai-pen}"
BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-platform/docker-compose.yml}"

cd "$REPO_ROOT"

if [[ ! -d .git ]]; then
  echo "ERROR: $REPO_ROOT is not a git checkout" >&2
  exit 1
fi

# Optional host env for public origin + compose (not rewritten by CD secrets)
if [[ -f /etc/my-ai-pen/beta.env ]]; then
  # shellcheck disable=SC1091
  set -a
  source /etc/my-ai-pen/beta.env
  set +a
fi
if [[ -f "$REPO_ROOT/platform/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/platform/.env"
  set +a
fi

echo "==> 1. git fetch + reset to origin/${BRANCH}"
git fetch origin
git reset --hard "origin/${BRANCH}"

echo "==> 2. docker compose up (db rabbitmq caddy; tunnel profile if TUNNEL_TOKEN set)"
cd "$REPO_ROOT/platform"
docker compose -f docker-compose.yml up -d db rabbitmq caddy
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  docker compose -f docker-compose.yml --profile tunnel up -d cloudflared
else
  echo "    WARN: TUNNEL_TOKEN unset — skipping cloudflared (set token for public edge)"
fi
cd "$REPO_ROOT"

echo "==> 3. backend: uv sync + alembic upgrade head"
cd "$REPO_ROOT/platform/backend"
if command -v uv >/dev/null 2>&1; then
  UV=uv
elif [[ -x "$HOME/.local/bin/uv" ]]; then
  UV="$HOME/.local/bin/uv"
else
  echo "ERROR: uv not found" >&2
  exit 1
fi
"$UV" sync
"$UV" run alembic upgrade head
cd "$REPO_ROOT"
# Note: do NOT run python -m app.db.seed on every deploy (would clobber beta data).

echo "==> 4. frontend: npm ci + production build (same-origin)"
cd "$REPO_ROOT/platform/frontend"
if [[ -z "${BETA_PUBLIC_ORIGIN:-}" ]]; then
  echo "WARN: BETA_PUBLIC_ORIGIN unset; browser WS may fall back to localhost defaults" >&2
else
  export VITE_BACKEND_URL="${BETA_PUBLIC_ORIGIN}"
  # wss when https
  if [[ "${BETA_PUBLIC_ORIGIN}" == https://* ]]; then
    export VITE_WS_URL="${BETA_PUBLIC_ORIGIN/https:/wss:}"
  else
    export VITE_WS_URL="${BETA_PUBLIC_ORIGIN/http:/ws:}"
  fi
  echo "    VITE_BACKEND_URL=$VITE_BACKEND_URL"
  echo "    VITE_WS_URL=$VITE_WS_URL"
fi
npm ci
npm run build
cd "$REPO_ROOT"

echo "==> 5. node4: npm ci"
cd "$REPO_ROOT/node4"
npm ci
cd "$REPO_ROOT"

echo "==> 6. systemctl restart my-ai-pen-backend my-ai-pen-node4"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart my-ai-pen-backend my-ai-pen-node4
  sudo systemctl --no-pager --full status my-ai-pen-backend my-ai-pen-node4 || true
else
  echo "WARN: systemctl not available (non-systemd host?)" >&2
fi

echo "==> deploy complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
