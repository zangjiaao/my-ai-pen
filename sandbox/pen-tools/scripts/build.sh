#!/usr/bin/env bash
# Build and tag first-party pen-tools image.
# Usage (from repo root):
#   bash sandbox/pen-tools/scripts/build.sh
#   bash sandbox/pen-tools/scripts/build.sh --no-cache
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/sandbox/pen-tools"
VERSION="$(tr -d '[:space:]' < "$DIR/VERSION")"
IMAGE_LOCAL="${PEN_TOOLS_IMAGE_LOCAL:-pen-tools:dev}"
IMAGE_VER="${PEN_TOOLS_IMAGE_VERSIONED:-pen-tools:${VERSION}}"
DATE_TAG="pen-tools:$(date -u +%Y.%m.%d)"

EXTRA=()
if [[ "${1:-}" == "--no-cache" ]]; then
  EXTRA+=(--no-cache)
fi

echo "[pen-tools] building $IMAGE_LOCAL and $IMAGE_VER (also $DATE_TAG)"
docker build "${EXTRA[@]}" \
  -t "$IMAGE_LOCAL" \
  -t "$IMAGE_VER" \
  -t "$DATE_TAG" \
  -f "$DIR/Dockerfile" \
  "$DIR"

echo "[pen-tools] done:"
docker image inspect "$IMAGE_LOCAL" --format '  {{.RepoTags}} {{.Id}}' 2>/dev/null || true
echo "  version file: $VERSION"
echo "  set PEN_TOOLS_IMAGE=$IMAGE_LOCAL (or $IMAGE_VER) for wrappers / Node4"
