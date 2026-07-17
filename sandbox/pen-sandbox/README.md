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
| `DOCKERHUB_USERNAME` | Hub user / org (image namespace) |
| `DOCKERHUB_TOKEN` | Hub **access token** (not password) |

On push to `main` touching `sandbox/pen-sandbox/**` (or manual **workflow_dispatch**):

```text
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:latest
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:dev
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:<VERSION>
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:v<VERSION>
docker.io/<DOCKERHUB_USERNAME>/pen-sandbox:sha-<short>
```

PRs build only (no push).

**Published (manual push 2026-07-18, account `billxlli`):**

```text
docker.io/billxlli/pen-sandbox:latest
docker.io/billxlli/pen-sandbox:dev
docker.io/billxlli/pen-sandbox:0.2.0
docker.io/billxlli/pen-sandbox:v0.2.0
```

Hub: https://hub.docker.com/r/billxlli/pen-sandbox

Node4 on a worker:

```bash
export PEN_SANDBOX_IMAGE=billxlli/pen-sandbox:latest
docker pull "$PEN_SANDBOX_IMAGE"
```

## Templates (data layer)

```bash
bash sandbox/pen-sandbox/scripts/update-templates.sh
```

## Env (Node4)

| Variable | Role |
|----------|------|
| `PEN_SANDBOX_IMAGE` | Preferred unified image (default resolution) |
| `PEN_TOOLS_IMAGE` | Shell override (falls back to pen-sandbox) |
| `NODE4_BROWSER_SANDBOX_IMAGE` | Browser override (falls back to pen-sandbox) |
| `NODE4_SHELL_IN_PEN_TOOLS=auto\|1\|0` | Shell-in-container (auto when image present) |

## Docs

[`docs/pen-tools-sandbox.md`](../../docs/pen-tools-sandbox.md) (strategy; now unified under pen-sandbox).
