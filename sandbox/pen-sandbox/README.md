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

| Knob | Purpose |
|------|---------|
| **Variable** `DOCKERHUB_NAMESPACE` | Hub user/org. Change here when the publish account moves — not hardcoded in the workflow. |
| **Secret** `DOCKERHUB_TOKEN` | Hub **access token**, on Environment **Docker Hub** (not a repo-level secret). Only needed for CI push on `main`. |

On push to `main` touching `sandbox/pen-sandbox/**` (or manual **workflow_dispatch**):

```text
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:latest
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:dev
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:<VERSION>
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:v<VERSION>
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:sha-<short>
```

PRs build only (no push).

**Current publish account** (set `DOCKERHUB_NAMESPACE` to this, or change both together):

```text
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:latest
docker.io/<DOCKERHUB_NAMESPACE>/pen-sandbox:dev
```

Node4 on a worker / production — pin the namespace you actually pulled:

```bash
export PEN_SANDBOX_IMAGE=<DOCKERHUB_NAMESPACE>/pen-sandbox:latest
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
