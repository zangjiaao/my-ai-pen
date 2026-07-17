# pen-tools changelog

## 0.1.0 — 2026-07-18

- VERSION `0.1.0`; `scripts/build.sh` tags `pen-tools:dev`, `pen-tools:0.1.0`, `pen-tools:YYYY.MM.DD`.
- `scripts/update-templates.sh` — nuclei-templates host cache without image rebuild.
- Host wrappers: `bin/nuclei`, `bin/nmap`, `bin/redis-cli` (docker run, fallback `pentest-sandbox:latest`).
- Node4 shell auto-prepends `sandbox/pen-tools/bin` via `buildShellEnv` (disable with `NODE4_PEN_TOOLS=0`).
- **S4:** Node4 `runShell` executes inside pen-tools when image present (`NODE4_SHELL_IN_PEN_TOOLS=auto|1|0`).
- Docs: `docs/pen-tools-sandbox.md` S0–S5.

## unreleased notes

- Optional later: shell fully inside container (S4); registry publish CI.
