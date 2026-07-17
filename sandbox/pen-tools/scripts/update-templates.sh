#!/usr/bin/env bash
# Refresh nuclei-templates into a host cache volume (no image rebuild).
# Usage:
#   bash sandbox/pen-tools/scripts/update-templates.sh
set -euo pipefail

IMAGE="${PEN_TOOLS_IMAGE:-pen-tools:dev}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if docker image inspect pentest-sandbox:latest >/dev/null 2>&1; then
    IMAGE=pentest-sandbox:latest
  else
    echo "[pen-tools] no image $IMAGE — build first: bash sandbox/pen-tools/scripts/build.sh" >&2
    exit 1
  fi
fi

CACHE="${PEN_TOOLS_NUCLEI_TEMPLATES:-$HOME/.cache/pen-tools/nuclei-templates}"
mkdir -p "$CACHE"
echo "[pen-tools] updating templates in $CACHE via $IMAGE"
docker run --rm \
  -v "$CACHE:/root/nuclei-templates" \
  "$IMAGE" \
  nuclei -update-templates

# stamp for ops observability
date -u +%Y-%m-%dT%H:%M:%SZ > "$CACHE/.last-update"
echo "[pen-tools] templates updated; stamp $CACHE/.last-update"
