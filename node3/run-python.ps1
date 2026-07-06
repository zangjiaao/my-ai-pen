$ErrorActionPreference = "Stop"

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "Node3 Python venv not found at $python. Run: uv sync --project node3"
}

& $python (Join-Path $PSScriptRoot "main.py")
