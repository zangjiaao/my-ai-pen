#!/usr/bin/env bash
# Refresh nuclei-templates host cache without rebuilding the image.
set -euo pipefail
IMAGE="${PEN_SANDBOX_IMAGE:-${PEN_TOOLS_IMAGE:-pen-sandbox:dev}}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  for t in pen-tools:dev pentest-sandbox:latest; do
    if docker image inspect "$t" >/dev/null 2>&1; then IMAGE=$t; break; fi
  done
fi
CACHE="${PEN_TOOLS_NUCLEI_TEMPLATES:-$HOME/.cache/pen-tools/nuclei-templates}"
mkdir -p "$CACHE"
echo "[pen-sandbox] updating templates via $IMAGE → $CACHE"
docker run --rm --entrypoint bash \
  -v "$CACHE:/root/nuclei-templates" \
  "$IMAGE" -lc "nuclei -update-templates"
date -u +%Y-%m-%dT%H:%M:%SZ > "$CACHE/.last-update"
echo "[pen-sandbox] stamp $CACHE/.last-update"
