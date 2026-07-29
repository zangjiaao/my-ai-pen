#!/usr/bin/env bash
# Host deploy entrypoint for internal beta (Spec #231 / map #151).
# Invoked by GitHub Actions SSH or manually as deploy@host.
# Failure policy: any step non-zero exits — no automatic git/DB rollback.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/my-ai-pen}"
BRANCH="${DEPLOY_BRANCH:-main}"
# Optional: pin to the SHA that passed product-smoke (workflow_run.head_sha)
DEPLOY_SHA="${DEPLOY_SHA:-}"

cd "$REPO_ROOT"

if [[ ! -d .git ]]; then
  echo "ERROR: $REPO_ROOT is not a git checkout" >&2
  exit 1
fi

# Host env for public origin + compose (not rewritten by CD secrets)
for envf in /etc/my-ai-pen/beta.env /etc/my-ai-pen/tunnel.env "$REPO_ROOT/platform/.env"; do
  if [[ -f "$envf" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$envf"
    set +a
  fi
done

echo "==> 1. git fetch + checkout"
# Host may be a shallow/single-branch clone (bootstrap depth=1). Deepen + fetch
# the smoke SHA so `git checkout DEPLOY_SHA` works under GitHub Actions CD.
git remote set-branches --add origin "${BRANCH}" 2>/dev/null || true
git fetch origin "${BRANCH}" --prune
# Unshallow if possible so arbitrary main SHAs are reachable
if git rev-parse --is-shallow-repository 2>/dev/null | grep -qx true; then
  git fetch --unshallow origin 2>/dev/null \
    || git fetch --deepen=200 origin "${BRANCH}" 2>/dev/null \
    || true
fi

if [[ -n "${DEPLOY_SHA}" ]]; then
  echo "    pin DEPLOY_SHA=${DEPLOY_SHA}"
  # GitHub allows fetch-by-SHA when the commit is on the remote
  if ! git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null; then
    git fetch origin "${DEPLOY_SHA}" 2>/dev/null \
      || git fetch origin "${BRANCH}" 2>/dev/null \
      || true
  fi
  if ! git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null; then
    echo "ERROR: DEPLOY_SHA ${DEPLOY_SHA} not present after fetch (shallow clone or missing commit)" >&2
    git rev-parse --is-shallow-repository 2>/dev/null || true
    git log -3 --oneline 2>/dev/null || true
    exit 1
  fi
  git checkout --detach "${DEPLOY_SHA}"
else
  echo "    branch origin/${BRANCH} (no DEPLOY_SHA pin)"
  git checkout -B "${BRANCH}" "origin/${BRANCH}"
fi

echo "==> 2. docker compose up (db rabbitmq + profile beta caddy; tunnel if token)"
cd "$REPO_ROOT/platform"
# Ensure dist dir exists so bind-mount does not create a root-owned empty dir by accident
mkdir -p frontend/dist
docker compose -f docker-compose.yml up -d db rabbitmq
docker compose -f docker-compose.yml --profile beta up -d caddy
EDGE_STATUS="caddy"
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  docker compose -f docker-compose.yml --profile tunnel up -d cloudflared
  EDGE_STATUS="caddy+cloudflared"
else
  echo "    WARN: TUNNEL_TOKEN unset — skipping cloudflared (public edge incomplete)"
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
# Alembic env imports app.* — package root must be on PYTHONPATH
export PYTHONPATH="$REPO_ROOT/platform/backend${PYTHONPATH:+:$PYTHONPATH}"
"$UV" run alembic upgrade head
cd "$REPO_ROOT"
# Do NOT run python -m app.db.seed on every deploy (would clobber beta data).

echo "==> 4. frontend: npm ci + production build (same-origin required)"
cd "$REPO_ROOT/platform/frontend"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/beta-fe-env.sh"
npm ci
npm run build
cd "$REPO_ROOT"

echo "==> 5. node4: npm ci + ensure expert packs on disk"
cd "$REPO_ROOT/node4"
npm ci
# UI offers alone do not copy pack files — install catalog packs used in product beta.
if [[ -f src/expert-cli.ts ]]; then
  npx tsx src/expert-cli.ts install pentest || echo "WARN: expert-cli install pentest failed"
fi
cd "$REPO_ROOT"

echo "==> 6. systemctl restart + health"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart my-ai-pen-backend my-ai-pen-node4
  sudo systemctl is-active --quiet my-ai-pen-backend
  sudo systemctl is-active --quiet my-ai-pen-node4
  # Backend health (loopback)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:8000/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 2
    if [[ "$i" -eq 10 ]]; then
      echo "ERROR: backend /api/health not healthy" >&2
      sudo systemctl --no-pager --full status my-ai-pen-backend my-ai-pen-node4 || true
      exit 1
    fi
  done
  # Caddy edge (same host)
  if ! curl -fsS "http://127.0.0.1:8080/api/health" >/dev/null 2>&1; then
    echo "ERROR: caddy :8080 /api/health failed" >&2
    exit 1
  fi
else
  echo "WARN: systemctl not available (non-systemd host?)" >&2
fi

echo "==> deploy complete at $(date -u +%Y-%m-%dT%H:%M:%SZ) edge=${EDGE_STATUS} sha=$(git rev-parse --short HEAD)"
