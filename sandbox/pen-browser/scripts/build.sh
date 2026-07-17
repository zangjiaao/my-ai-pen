#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/sandbox/pen-browser"
VERSION="$(tr -d '[:space:]' < "$DIR/VERSION")"
IMAGE_LOCAL="${PEN_BROWSER_IMAGE_LOCAL:-pen-browser:dev}"
IMAGE_VER="${PEN_BROWSER_IMAGE_VERSIONED:-pen-browser:${VERSION}}"

echo "[pen-browser] building $IMAGE_LOCAL / $IMAGE_VER (may take several minutes)"
docker build \
  -t "$IMAGE_LOCAL" \
  -t "$IMAGE_VER" \
  -f "$DIR/Dockerfile" \
  "$DIR"
echo "[pen-browser] done. Set NODE4_BROWSER_SANDBOX_IMAGE=$IMAGE_LOCAL"
