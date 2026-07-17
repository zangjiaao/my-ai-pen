# Pen-tools sandbox strategy (L2)

**Status:** active — first-party ownership direction (2026-07-18)  
**Related:** [`pentest-next-steps.md`](pentest-next-steps.md) Phase S · [`expert-pack-capability-and-maintenance.md`](expert-pack-capability-and-maintenance.md) L1/L2/L3 · [`../sandbox/pen-tools/`](../sandbox/pen-tools/)

---

## 1. Why this exists

Lab Phase L showed:

- Pack **1.1.1** correctly prefers **nuclei-first** for named products.
- Host **PATH had no nuclei** → agent detected absence and fell back.
- Browser isolation already uses **`ghcr.io/usestrix/strix-sandbox`** (third-party, browser-centric).

**Conclusion:** L2 tooling (scanners, redis-cli, wordlists, nuclei-templates) is a **product surface** we must own. Relying on Strix for “everything in Docker” mixes two concerns and leaves shell scanners on the host by accident.

---

## 2. Two sandboxes (do not conflate)

```
┌─────────────────────────────────────────────────────────────┐
│ Node4 (OMP runtime — stays pure)                            │
│  shell  → currently host process (taskDir cwd)              │
│  browser → Docker image (Chromium + agent-browser)          │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────────┐    ┌──────────────────────────────┐
│ pen-tools (OURS)     │    │ browser sandbox (strix today)│
│ nuclei nmap sqlmap   │    │ Chromium, agent-browser      │
│ ffuf redis-cli …     │    │ future: first-party browser  │
│ nuclei-templates     │    │ image when we leave Strix    │
└──────────────────────┘    └──────────────────────────────┘
```

| Concern | Image / env | Owner |
|---------|-------------|--------|
| Known-issue scans, recon CLIs | **`pen-tools`** | **my-ai-pen** |
| Browser automation | strix-sandbox (env-overridable) | Upstream for now; pin version |
| Expert methodology | `experts/pentest` pack | my-ai-pen L1 |
| Shell semantics | Node4 `shell` tool | my-ai-pen runtime |

Strix remains **browser-only**. Do not expect Strix to ship or update nuclei-templates for our nuclei-first policy.

---

## 3. What already exists

| Artifact | Role |
|----------|------|
| `node/Dockerfile.sandbox` | Legacy Kali-based scanner image (nuclei, nmap, sqlmap, …) |
| Local image `pentest-sandbox:latest` | Built earlier from that lineage; has nuclei + templates |
| `node4` shell | **Host** bash — does not auto-enter pen-tools |
| `node4` browser-sandbox.ts | Defaults to **strix** image |
| `sandbox/pen-tools/` | **New first-party tree** (Dockerfile, wrappers, README) |

---

## 4. Ownership roadmap

### S0 — Document + wrappers (this change)

- First-party `sandbox/pen-tools/Dockerfile` + README.  
- Host `bin/nuclei` (etc.) shims → `docker run pen-tools|pentest-sandbox`.  
- Lab PATH can include shims so Agent shell finds `nuclei` without host apt install.

### S1 — Image as product artifact

- CI builds/publishes `pen-tools:<semver>` (registry TBD).  
- Node/lab env: `PEN_TOOLS_IMAGE=pen-tools:x.y.z`.  
- Template **data volume** update path documented (no rebuild per n-day).

### S2 — Optional shell-in-container

- Node4 `shell` option: execute command inside pen-tools with `taskDir` mounted.  
- Keeps host clean; stronger isolation; bigger runtime change — only after S0/S1 stable.  
- Must preserve OMP density (timeouts, process group kill, observation recording).

### S3 — Browser independence (later)

- Evaluate forking or replacing strix with first-party browser image.  
- Until then: pin Strix digest; document override `NODE4_BROWSER_SANDBOX_IMAGE`.

---

## 5. Versioning (aligns with pack L1/L2 split)

| Artifact | Version |
|----------|---------|
| Expert pack | `experts/pentest/pack.json` semver |
| pen-tools image | `pen-tools:YYYY.MM.DD` or semver |
| nuclei-templates | volume stamp / git sha (independent) |
| Strix browser | pinned tag/digest |
| Node4 package | `node4/package.json` |

Changelog for pen-tools: `sandbox/pen-tools/CHANGELOG.md` (create on first published tag).

---

## 6. Lab / ops checklist

- [ ] `docker build -t pen-tools:dev -f sandbox/pen-tools/Dockerfile sandbox/pen-tools` **or** `docker tag pentest-sandbox:latest pen-tools:dev`  
- [ ] `export PATH="$REPO/sandbox/pen-tools/bin:$PATH"`  
- [ ] `nuclei -version` works via shim  
- [ ] Re-run MinIO lab: expect real `nuclei -tags minio` (or equivalent), not only “nuclei not found”  
- [ ] Keep templates fresh: volume mount + periodic `-update-templates`  

---

## 7. Non-goals

- Putting full tool encyclopedia into expert pack prompts.  
- Making Strix responsible for n-day template freshness.  
- Blocking pack releases on pen-tools rebuild (L1/L2 independent).  
- One mega-image for browser + all scanners unless ops explicitly wants it later.

---

## 8. One-line summary

**Own pen-tools for scanners (L2); keep Strix as temporary browser sandbox; Node stays OMP-pure; expert packs only teach when to call tools — pen-tools supplies the binaries and templates.**
