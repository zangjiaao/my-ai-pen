# pen-sandbox — unified pentest expert environment

**One image for the pentest expert pack:** scanners **and** browser.

| Tool | How Node4 uses this image |
|------|---------------------------|
| `shell` | `docker run --rm --network host -v taskDir:/workspace` (S4) |
| `browser` | Long-lived container + `docker exec agent-browser` (S5) |

Not Strix. Not two product images. Optional thin trees `pen-tools/` / `pen-browser/` are **legacy aliases** (see their READMEs).

## Build (local)

```bash
bash sandbox/pen-sandbox/scripts/build.sh
# optional push:
# DOCKERHUB_USERNAME=you PEN_SANDBOX_PUSH=1 bash sandbox/pen-sandbox/scripts/build.sh
```

Also tags `pen-tools:dev` and `pen-browser:dev` for older env vars.

## CI → Docker Hub

GitHub Actions: [`.github/workflows/pen-sandbox.yml`](../../.github/workflows/pen-sandbox.yml)

| Secret | Purpose |
|--------|---------|
| `DOCKERHUB_TOKEN` | Hub **access token** (not password). Optional — only for CI push to `zangjiaao/pen-sandbox`. Namespace is hardcoded `zangjiaao`. |

On push to `main` touching `sandbox/pen-sandbox/**` (or manual **workflow_dispatch**):

```text
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:latest
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:dev
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:<VERSION>
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:v<VERSION>
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:sha-<short>
```

PRs build only (no push).

**Published namespace:** [`zangjiaao/pen-sandbox`](https://hub.docker.com/r/zangjiaao/pen-sandbox) (old `billxlli/pen-sandbox` is retired).

```text
docker.io/zangjiaao/pen-sandbox:latest
docker.io/zangjiaao/pen-sandbox:dev
docker.io/zangjiaao/pen-sandbox:0.2.0
docker.io/zangjiaao/pen-sandbox:v0.2.0
```

Node4 on a worker / production:

```bash
export PEN_SANDBOX_IMAGE=zangjiaao/pen-sandbox:latest
docker pull "$PEN_SANDBOX_IMAGE"
```

## Templates (data layer)

```bash
bash sandbox/pen-sandbox/scripts/update-templates.sh
```

## Env (Node4)

| Variable | Role |
|----------|------|
| `PEN_SANDBOX_IMAGE` | Preferred unified image pin (**required** for browser sandbox path) |
| `PEN_TOOLS_IMAGE` | Shell override (same image family); also accepted as browser pin if set |
| `NODE4_BROWSER_SANDBOX_IMAGE` | Browser override (wins over unified pin) |
| `NODE4_SHELL_IN_PEN_TOOLS=auto\|1\|0` | Shell-in-container (auto when image present) |

Browser path does not fall back to third-party Strix images. See Spec #320 / #330.

## Docs

[`docs/specs/pen-tools-sandbox.md`](../../docs/specs/pen-tools-sandbox.md) (strategy; unified under pen-sandbox).
