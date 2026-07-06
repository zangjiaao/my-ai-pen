$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$python = Join-Path $repoRoot "research\strix\.venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "Strix Python venv not found at $python. Run: uv sync --project research\strix"
}

& $python (Join-Path $PSScriptRoot "main.py")
