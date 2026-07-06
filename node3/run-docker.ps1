$ErrorActionPreference = "Stop"

$env:PLATFORM_WS_URL = "ws://host.docker.internal:8000/ws"
$env:STRIX_PROJECT_DIR = "/workspace/node3/workspace/strix_runtime"

docker compose -f (Join-Path $PSScriptRoot "docker-compose.yml") up --build node3
