# Node3 Strix Adapter

Node3 is an experimental platform node that runs `research/strix` and imports Strix artifacts back into the existing platform websocket protocol.

It is intended for benchmark comparison against Node2, not as a replacement for the Pi-first runtime.

## Run

Use the Docker adapter as the default path on Windows. This keeps the Node3/Strix process in a Linux filesystem and avoids antivirus deleting Python source files from `research/strix`.

Configure `node3/.env`, then start Node3:

```powershell
.\node3\run-docker.ps1
```

The container mounts:

- `research/strix/strix_runs` as `/workspace/research/strix/strix_runs`
- `/var/run/docker.sock` so Strix can start its own sandbox container

The Node3 and Strix source trees are copied into the image at build time. Rebuild after changing `node3/` or `research/strix/`.

`PLATFORM_WS_URL` should usually be `ws://host.docker.internal:8000/ws` when Node3 runs in Docker and the platform backend runs on the host.

## Local Python Fallback

Use this only when the local checkout is not being modified by antivirus.

Prepare Strix once:

```powershell
uv sync --project research\strix
```

Start Node3:

```powershell
.\node3\run-python.ps1
```

Node-directed chat messages without a target use the same Strix LLM configuration as scans.

Strix model/provider variables are read directly by Strix, for example `STRIX_LLM` and `LLM_API_KEY`.
Docker must also be running because Strix starts its sandbox/Caido sidecar from Docker.

## Platform Notes

Register this as a normal `pentest` node in the platform so it provides the existing `pentest.web` capability. Use a separate node token from Node2 when running both nodes.

Node3 sends:

- `status_update` for scan progress
- `text` for bounded Strix stdout/stderr chunks
- `evidence_created` for the Strix run report and each vulnerability report
- `vuln_found` for confirmed Strix vulnerabilities
- `checkpoint_update` with `node3_strix.run_name` and `run_dir`
- `task_complete` or `task_error`

Strix writes artifacts under:

```text
research/strix/strix_runs/<run-name>/
```

Node3 imports `run.json`, `vulnerabilities.json`, `vulnerabilities/<id>.md`, and `penetration_test_report.md`.
