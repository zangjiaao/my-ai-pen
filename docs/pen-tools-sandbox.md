# Pentest sandbox strategy (unified L2)

**Status:** active — **one image for the pentest expert** (`pen-sandbox`)  
**Tree:** [`../sandbox/pen-sandbox/`](../sandbox/pen-sandbox/)  
**Related:** [`pentest-next-steps.md`](pentest-next-steps.md) · pack `experts/pentest`

---

## 1. One container for the pentest expert

Shell scanners and browser automation share **`pen-sandbox`**:

```
Node4 (OMP)
  shell   → pen-sandbox (docker run --rm, taskDir mount)
  browser → pen-sandbox (long-lived session + exec agent-browser)
```

| Concern | Image |
|---------|--------|
| nuclei / nmap / sqlmap / ffuf / redis-cli | **pen-sandbox** |
| agent-browser + Chrome | **same pen-sandbox** |
| Expert methodology | `experts/pentest` pack (L1) |

Legacy names `pen-tools` / `pen-browser` may still appear as **tags aliased at build time**; do not maintain two product images.

---

## 2. Does Strix include a shell?

**Yes.** Strix is a full Kali-class box (bash, nuclei, Chromium, agent-browser).  
Node4 never used Strix for the **shell tool** (host / pen-sandbox only). Browser may still **fall back** to Strix if no first-party image is built.

We own **pen-sandbox** so template freshness, browser pin, and release cadence are under our control.

---

## 3. Build, CI & templates

```bash
# Local
bash sandbox/pen-sandbox/scripts/build.sh
bash sandbox/pen-sandbox/scripts/update-templates.sh   # nuclei-templates host cache
```

**Docker Hub CI:** `.github/workflows/pen-sandbox.yml`  
Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (access token).  
Image: `<user>/pen-sandbox:{latest,dev,<version>,sha-*}`.

Aliases at local build: `pen-tools:dev` / `pen-browser:dev` for old env vars.

Worker:

```bash
export PEN_SANDBOX_IMAGE=<user>/pen-sandbox:latest
docker pull "$PEN_SANDBOX_IMAGE"
```

---

## 4. Node4 env

| Variable | Role |
|----------|------|
| `PEN_SANDBOX_IMAGE` | Preferred unified image |
| `PEN_TOOLS_IMAGE` | Shell override (same image family) |
| `NODE4_BROWSER_SANDBOX_IMAGE` | Browser override |
| `NODE4_SHELL_IN_PEN_TOOLS=auto\|1\|0` | Shell-in-container (auto when image present) |
| `NODE4_BROWSER_SANDBOX=0` | Host agent-browser only |
| `NODE4_PEN_TOOLS=0` | Disable host PATH shims |

Resolution: `node4/src/runtime/pentest-sandbox-image.ts`.

---

## 5. Why not two images anymore?

Split was for update isolation; **ops cost** was higher than benefit for a single pentest expert.  
Templates still update via **volume** without full rebuild. Browser and scanners ship together for one build/deploy story.

---

## 6. Tooling health (doctor) — observability only

Phase **S3**: Node4 can report whether the L2 shell path is ready **without blocking** tasks, tools, booking, or settlement.

| Surface | How |
|---------|-----|
| CLI | `cd node4 && npm run doctor:pen-tools` (or `npx tsx src/tooling-health-cli.ts`) |
| Flags | `--json` machine-readable; `--fast` skip container binary probe (image/shim/host only) |
| Task start | Non-chat execution packs with `shell`: write `taskDir/tooling-health.json` + one `status_update` summary |
| Code | `node4/src/runtime/tooling-health.ts` |

**Report fields (factual env state only):** resolved sandbox image + present?, shell mode (`container` \| `host`), host pen-tools bin/PATH shim, key tools (`nuclei`, `nmap`, `sqlmap`, `ffuf`, `redis-cli`). `gating` is always `false`. Missing `nuclei` marks `degraded: true` but **exit code stays 0** and the harness still runs.

```bash
cd node4
npm run doctor:pen-tools
# optional
npm run doctor:pen-tools -- --fast
npm run doctor:pen-tools -- --json
```

Do **not** treat doctor output as agent planning text or as a hard gate.

---

## 7. One-line summary

**One first-party pen-sandbox for the pentest expert — shell and browser; Strix only as emergency browser fallback. Tooling health is optional observability, never a gate.**
