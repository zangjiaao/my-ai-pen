#!/usr/bin/env bash
# Map BETA_PUBLIC_ORIGIN → Vite same-origin build env (Spec #231).
# Source from beta-deploy.sh or manual bootstrap:
#   source scripts/beta-fe-env.sh && npm run build
#
# Requires BETA_PUBLIC_ORIGIN (https://host) OR both VITE_BACKEND_URL and VITE_WS_URL already set.
set -euo pipefail

if [[ -n "${VITE_BACKEND_URL:-}" && -n "${VITE_WS_URL:-}" ]]; then
  export VITE_BACKEND_URL VITE_WS_URL
  return 0 2>/dev/null || exit 0
fi

if [[ -z "${BETA_PUBLIC_ORIGIN:-}" ]]; then
  echo "ERROR: set BETA_PUBLIC_ORIGIN (e.g. https://beta.example.com) or both VITE_BACKEND_URL and VITE_WS_URL" >&2
  return 1 2>/dev/null || exit 1
fi

# strip trailing slash
origin="${BETA_PUBLIC_ORIGIN%/}"
export VITE_BACKEND_URL="${origin}"
if [[ "${origin}" == https://* ]]; then
  export VITE_WS_URL="wss://${origin#https://}"
elif [[ "${origin}" == http://* ]]; then
  export VITE_WS_URL="ws://${origin#http://}"
else
  echo "ERROR: BETA_PUBLIC_ORIGIN must start with http:// or https://" >&2
  return 1 2>/dev/null || exit 1
fi

echo "VITE_BACKEND_URL=${VITE_BACKEND_URL}"
echo "VITE_WS_URL=${VITE_WS_URL}"
