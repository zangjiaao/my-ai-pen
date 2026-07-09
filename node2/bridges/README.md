# Node2 Traffic Bridges

Node2 stays Pi-first. Bridges only provide execution-layer traffic truth from mature tools such as Caido.

## Caido Traffic Bridge

The Caido bridge exposes Strix/Caido proxy history through Node2's generic external traffic source API:

- `GET /status`
- `GET /traffic?limit=50&method=POST&url_contains=/api`
- `GET /traffic/{caido_request_id}`

Start it with the Strix virtualenv so `caido_sdk_client` is available:

```powershell
D:\Coding\my-ai-pen\research\strix\.venv\Scripts\python.exe node2\bridges\caido_traffic_bridge.py --port 48180
```

Then start Node2 with:

```powershell
$env:NODE2_EXTERNAL_TRAFFIC_SOURCE_URL = "http://127.0.0.1:48180"
$env:NODE2_TRAFFIC_PROXY_URL = "http://127.0.0.1:8080"
npm run dev
```

Or let Node2 start the bridge process per task against an existing Caido:

```powershell
$env:NODE2_CAIDO_BRIDGE_AUTO = "1"
$env:STRIX_CAIDO_URL = "http://127.0.0.1:48080"
npm run dev
```

For Strix-style per-task Caido, let Node2 start both the bridge and the Docker sidecar:

```powershell
$env:NODE2_CAIDO_BRIDGE_AUTO = "1"
$env:NODE2_CAIDO_SIDECAR_AUTO = "1"
$env:NODE2_CAIDO_SIDECAR_IMAGE = "ghcr.io/usestrix/strix-sandbox:1.0.0"
npm run dev
```

When sidecar auto mode is enabled, Node2 routes browser/http/verifier traffic through the sidecar's Caido proxy, and `traffic(action="sync")` imports the captured proxy history back into Node2.

If the target is a service running on the host machine, use a URL that is reachable from Docker, such as `http://host.docker.internal:8080`, instead of `http://localhost:8080`. The DVWA benchmark harness does this automatically when `--caido-sidecar true` is enabled, unless `--sidecar-target` is provided.

Inside a scan, the Agent should call:

1. `traffic(action="source_status")`
2. Browse or scan the target through the configured proxy.
3. `traffic(action="sync", limit=100)`
4. `traffic(action="analyze")` or `traffic(action="candidates")`
5. `traffic(action="repeat")` and `traffic(action="mutate")` before verifier/finding.

Browser automation runs inside the same `strix-sandbox` image via a long-lived container and `agent-browser` (Node3-aligned). Host Playwright is not required for the `browser` tool. When Caido sidecar auto mode is enabled, browser sandbox processes inherit proxy env so traffic can land in Caido; `http`/`verifier` still run from the Node2 host process (or scan sandbox) and merge cookies from `browser(action='snapshot')`.
