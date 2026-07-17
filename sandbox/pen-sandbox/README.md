# pen-sandbox — unified pentest expert environment

**One image for the pentest expert pack:** scanners **and** browser.

| Tool | How Node4 uses this image |
|------|---------------------------|
| `shell` | `docker run --rm --network host -v taskDir:/workspace` (S4) |
| `browser` | Long-lived container + `docker exec agent-browser` (S5) |

Not Strix. Not two product images. Optional thin trees `pen-tools/` / `pen-browser/` are **legacy aliases** (see their READMEs).

## Build

```bash
bash sandbox/pen-sandbox/scripts/build.sh
```

Also tags `pen-tools:dev` and `pen-browser:dev` for older env vars.

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
