# Node3 Embedded Strix Node

Node3 is an experimental platform node that vendors Strix source under `node3/strix` and bridges Strix-native runtime events back into the existing platform websocket protocol.

It is intended for benchmark comparison against Node2, not as a replacement for the Pi-first runtime.

## Run

Use the local Python entrypoint as the default path. Node3 now vendors the Strix source under `node3/strix`, so the platform node process does not need to run inside Docker just to execute Strix.

Configure `node3/.env`, then start Node3:

```powershell
uv sync --project node3
.\node3\run-python.ps1
```

Node-directed chat messages without a target use the same Strix LLM configuration as scans.

Strix model/provider variables are read directly by Strix, for example `STRIX_LLM` and `LLM_API_KEY`.

Docker may still need to be running for Strix-managed sandbox/Caido sidecars, depending on the tools used by a scan. That is different from running the Node3 process itself in Docker.

### Scan Modes

Node3 supports Strix `quick`, `standard`, and `deep` scan modes. The local default is `standard`.

- `quick`: time-boxed high-impact checks; useful for fast signal, not full coverage.
- `standard`: balanced coverage-first assessment; best default for normal web-app testing and benchmark comparison.
- `deep`: exhaustive coverage and chaining; highest cost.

## Docker Fallback

The Docker runner is still available as a fallback when the local Python environment is unsuitable:

```powershell
.\node3\run-docker.ps1
```

The container mounts:

- `node3/workspace` as `/workspace/node3/workspace`
- `/var/run/docker.sock` so Strix can start its own sandbox container

The Node3 source tree includes the Strix runtime. Rebuild after changing `node3/`.

`PLATFORM_WS_URL` should usually be `ws://host.docker.internal:8000/ws` when Node3 runs in Docker and the platform backend runs on the host.

## Standalone Mode

Node3 can run like Node1's standalone mode without the platform. By default it uses the Strix TUI and writes local runs under `node3/workspace/standalone/strix_runs`.

```powershell
node3\.venv\Scripts\python.exe node3\main.py standalone --target http://host.docker.internal:8080 --tui
```

For headless standalone runs:

```powershell
node3\.venv\Scripts\python.exe node3\main.py standalone --target http://host.docker.internal:8080 --no-tui --scan-mode standard
```

Resume a prior run by Strix run name:

```powershell
node3\.venv\Scripts\python.exe node3\main.py standalone --resume <run-name> --tui
```

## Runtime Model

Node3 does not shell out to `strix -n` for scans. It runs `strix.core.runner.run_strix_scan()` in-process with a Node3 bridge that maps:

- Strix SDK stream events to platform `text` and `tool_output`
- `ReportState.vulnerability_found_callback` to platform `evidence_created` and `vuln_found`
- final Strix reports to platform `evidence_created`
- run metadata to platform `checkpoint_update`

This keeps Strix skills, tools, Caido/sandbox lifecycle, and multi-agent orchestration native to Strix while preserving the platform Node protocol. Node3 loads Strix from `node3/strix`, so frontend/platform compatibility changes can be made directly in the Node3-owned Strix copy.

## Platform Notes

Register this as a normal `pentest` node in the platform so it provides the existing `pentest.web` capability. Use a separate node token from Node2 when running both nodes.

Node3 sends:

- `status_update` for scan progress
- `text` for Strix assistant messages
- `tool_output` for Strix tool call start/finish events
- `evidence_created` for the Strix run report and each vulnerability report
- `vuln_found` for confirmed Strix vulnerabilities
- `checkpoint_update` with `node3_strix.run_name` and `run_dir`
- `task_complete` or `task_error`

Platform mode writes artifacts under:

```text
node3/workspace/strix_runtime/strix_runs/<run-name>/
```

Node3 synchronizes `run.json`, `vulnerabilities.json`, `vulnerabilities/<id>.md`, and `penetration_test_report.md` through platform events.
