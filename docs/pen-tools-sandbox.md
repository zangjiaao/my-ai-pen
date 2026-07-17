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

## 3. Build & templates

```bash
bash sandbox/pen-sandbox/scripts/build.sh
bash sandbox/pen-sandbox/scripts/update-templates.sh   # nuclei-templates host cache
```

Aliases created: `pen-sandbox:dev`, also `pen-tools:dev` / `pen-browser:dev` for old env vars.

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

## 6. One-line summary

**One first-party pen-sandbox for the pentest expert — shell and browser; Strix only as emergency browser fallback.**
