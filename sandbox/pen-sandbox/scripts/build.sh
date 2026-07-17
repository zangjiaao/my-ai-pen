#!/usr/bin/env bash
# Build unified pentest sandbox and convenience aliases.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/sandbox/pen-sandbox"
VERSION="$(tr -d '[:space:]' < "$DIR/VERSION")"
IMAGE_LOCAL="${PEN_SANDBOX_IMAGE_LOCAL:-pen-sandbox:dev}"
IMAGE_VER="${PEN_SANDBOX_IMAGE_VERSIONED:-pen-sandbox:${VERSION}}"

EXTRA=()
[[ "${1:-}" == "--no-cache" ]] && EXTRA+=(--no-cache)

# Prefer local scanner bases for FROM
BASE="${PEN_SANDBOX_BASE:-}"
if [[ -z "$BASE" ]]; then
  if docker image inspect pen-tools:dev >/dev/null 2>&1; then BASE=pen-tools:dev
  elif docker image inspect pentest-sandbox:latest >/dev/null 2>&1; then BASE=pentest-sandbox:latest
  else
    echo "[pen-sandbox] no pen-tools:dev / pentest-sandbox:latest — building pen-tools first is recommended"
    echo "  bash sandbox/pen-tools/scripts/build.sh"
    echo "  or: docker tag pentest-sandbox:latest pen-tools:dev"
    BASE=pen-tools:dev
  fi
fi
echo "[pen-sandbox] base=$BASE → $IMAGE_LOCAL / $IMAGE_VER"

docker build "${EXTRA[@]}" \
  --build-arg "PEN_SANDBOX_BASE=$BASE" \
  -t "$IMAGE_LOCAL" \
  -t "$IMAGE_VER" \
  -f "$DIR/Dockerfile" \
  "$DIR"

# Alias tags so older Node4 env names keep working
docker tag "$IMAGE_LOCAL" pen-tools:dev
docker tag "$IMAGE_LOCAL" pen-browser:dev
docker tag "$IMAGE_VER" "pen-tools:${VERSION}"
docker tag "$IMAGE_VER" "pen-browser:${VERSION}"

echo "[pen-sandbox] done."
echo "  primary: $IMAGE_LOCAL / $IMAGE_VER"
echo "  aliases: pen-tools:dev, pen-browser:dev"
echo "  env:     PEN_SANDBOX_IMAGE=$IMAGE_LOCAL  (or PEN_TOOLS_IMAGE / NODE4_BROWSER_SANDBOX_IMAGE)"
