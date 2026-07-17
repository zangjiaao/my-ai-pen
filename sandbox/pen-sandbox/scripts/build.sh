#!/usr/bin/env bash
# Build unified pen-sandbox (self-contained Dockerfile) and optional push helpers.
# Usage:
#   bash sandbox/pen-sandbox/scripts/build.sh
#   PEN_SANDBOX_PUSH=1 DOCKERHUB_USERNAME=myuser bash sandbox/pen-sandbox/scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/sandbox/pen-sandbox"
VERSION="$(tr -d '[:space:]' < "$DIR/VERSION")"
IMAGE_LOCAL="${PEN_SANDBOX_IMAGE_LOCAL:-pen-sandbox:dev}"
IMAGE_VER="${PEN_SANDBOX_IMAGE_VERSIONED:-pen-sandbox:${VERSION}}"

EXTRA=()
[[ "${1:-}" == "--no-cache" ]] && EXTRA+=(--no-cache)

echo "[pen-sandbox] building $IMAGE_LOCAL / $IMAGE_VER"
docker build "${EXTRA[@]}" \
  -t "$IMAGE_LOCAL" \
  -t "$IMAGE_VER" \
  -f "$DIR/Dockerfile" \
  "$DIR"

# Compat aliases for older Node4 env names
docker tag "$IMAGE_LOCAL" pen-tools:dev
docker tag "$IMAGE_LOCAL" pen-browser:dev
docker tag "$IMAGE_VER" "pen-tools:${VERSION}"
docker tag "$IMAGE_VER" "pen-browser:${VERSION}"

if [[ "${PEN_SANDBOX_PUSH:-0}" == "1" ]]; then
  USERNAME="${DOCKERHUB_USERNAME:?set DOCKERHUB_USERNAME}"
  REMOTE="${USERNAME}/pen-sandbox"
  docker tag "$IMAGE_LOCAL" "${REMOTE}:dev"
  docker tag "$IMAGE_LOCAL" "${REMOTE}:latest"
  docker tag "$IMAGE_VER" "${REMOTE}:${VERSION}"
  docker push "${REMOTE}:dev"
  docker push "${REMOTE}:latest"
  docker push "${REMOTE}:${VERSION}"
  echo "[pen-sandbox] pushed ${REMOTE}:{dev,latest,${VERSION}}"
fi

echo "[pen-sandbox] done."
echo "  local:  $IMAGE_LOCAL / $IMAGE_VER"
echo "  env:    PEN_SANDBOX_IMAGE=$IMAGE_LOCAL"
