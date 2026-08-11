# Pentest sandbox strategy (unified L2)

**Status:** active — **one image for the pentest expert** (`pen-sandbox`)  
**Tree:** [`../sandbox/pen-sandbox/`](../sandbox/pen-sandbox/)  
**Related:** [`pentest-next-steps.md`](pentest-next-steps.md) · pack `experts/pentest`

---

## 1. One container for the pentest expert

Shell scanners and browser automation share **`pen-sandbox`**.

**Product lifetime (supersedes Spec #320 task-end dispose):** one **Session-sticky** long-lived pen-sandbox per **Participant Session** `(conversationId, expertId)` — browser + shell/scanners in the **same** box. See **§4** and Spec issue linked there (wayfinder map #418).

```
Node4 (OMP) — target model
  Session seat (conversationId + expertId)
    pen-sandbox (long-lived; stop on idle / Node shutdown; rm on seat/Case death)
      browser  → exec agent-browser (profile in-box)
      shell    → docker exec (not per-command --rm)
      scanners → same image
  Session workspace (host) → mount /workspace (SoT for scripts/evidence)
```

| Concern | Image |
|---------|--------|
| nuclei / nmap / sqlmap / ffuf / redis-cli | **pen-sandbox** |
| agent-browser + Chrome | **same pen-sandbox** |
| Expert methodology | `experts/pentest` pack (L1) |

Legacy names `pen-tools` / `pen-browser` may still appear as **tags aliased at build time**; do not maintain two product images.

**Shipped (Spec [#426](https://github.com/zangjiaao/my-ai-pen/issues/426) tickets [#427](https://github.com/zangjiaao/my-ai-pen/issues/427)–[#431](https://github.com/zangjiaao/my-ai-pen/issues/431)):** Session-seat sticky pen-sandbox — key, workspace mount, sticky shell exec, Session/Case `rm`, idle/Node `stop`, session labels + docs.

---

## 2. Strix is not a product browser default

Strix is a full Kali-class box (bash, nuclei, Chromium, agent-browser) used historically as a research/comparison runtime.  
Node4 **never** used Strix for the **shell tool** (host / pen-sandbox only). As of Spec #320 / #330, the **browser sandbox path also does not fall back to Strix**.

Browser sandbox requires an **explicit first-party image pin** (`PEN_SANDBOX_IMAGE` and/or `NODE4_BROWSER_SANDBOX_IMAGE`). Missing pin → hard failure of the sandbox path with an operator-actionable error. Host agent-browser remains available only when sandbox is explicitly disabled (`NODE4_BROWSER_SANDBOX=0` / `host`) or after a configured image fails to start.

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
| `PEN_SANDBOX_IMAGE` | Preferred unified image pin (**required** for browser sandbox path) |
| `PEN_TOOLS_IMAGE` | Shell override (same image family); also accepted as browser pin if set |
| `NODE4_BROWSER_SANDBOX_IMAGE` | Browser override (wins over unified pin) |
| `NODE4_SHELL_IN_PEN_TOOLS=auto\|1\|0` | Shell-in-container (auto when image present) |
| `NODE4_BROWSER_SANDBOX=0` | Host agent-browser only |
| `NODE4_PEN_TOOLS=0` | Disable host PATH shims |
| `NODE4_BROWSER_SANDBOX_HEARTBEAT_MS` | Lease renewal interval while Session box is held/running (default ~90s); retarget from parent-task hold |
| `NODE4_BROWSER_SANDBOX_LEASE_MS` | Lease TTL without renewal (default ~12 min); expired → janitor may **rm** orphans only when policy allows |
| `NODE4_BROWSER_SANDBOX_JANITOR_MS` | Periodic reap interval (default ~120s); startup also runs one pass |
| `PEN_SANDBOX_IDLE_STOP_MS` | Idle **stop** clock: no pen-sandbox tool traffic for this seat (default **4h**); **stop**, never product idle **rm**. `0` disables |

**Browser resolution (strict):** `node4/src/runtime/browser-sandbox.ts` → `resolveBrowserSandboxImage` — explicit env only; no ambient local-tag discovery; no Strix default.  
**Shell resolution:** `node4/src/runtime/pentest-sandbox-image.ts` / `pen-tools-shell.ts` — may still discover local first-party tags for lab convenience; sticky model uses **exec into Session box**.

### Pen-sandbox lifecycle (Session-sticky — supersedes Spec #320)

**Wayfinder:** [map #418](https://github.com/zangjiaao/my-ai-pen/issues/418). **Identity:** Participant Session `(conversationId, expertId)` — not `parentTaskId`, not pi `Agent.sessionId`. Fail-closed if `expertId` missing. Main + sub-agents under that seat share **one** box.

**Two verbs:**

| Verb | Docker | When |
|------|--------|------|
| **stop** | `docker stop` | No sandbox tool traffic for default **4h**; Node graceful shutdown (all sticky boxes on host) |
| **rm** | `docker rm -f` | Session Delete; Case delete (all seats); expert transfer (old seat); orphan janitor after seat already dead |

**Must not stop/rm:** work-burst complete/error; user interrupt; Session Reset; captain park / package settle; park drop without seat death.

**Attach:** seat live + running → reuse; stopped → `start` same container; none → create. Hard cutover from #320 (no dual-mode task\|session flag).

**Workspace SoT:** host path `{NODE4_WORKSPACE}/sessions/{conversationId}/{expertId}/` mounted at `/workspace` (rw). Durable subdirs include `scripts/`, `evidence/`, `findings/`, `credentials/`, `exports/`, `notes/`. Login **primary** = in-box browser profile + stickiness; optional cookie/profile packs under `credentials/` for agent import (v1 file slot; dedicated captcha UI is **future**).

**Multi-seat:** one box per seat; never rebind/inherit box across experts; cross-seat only explicit file export/import; multiple seat boxes may coexist on one Case.

**Hooks:** `session_dispose` / `case_session_release` / park force-dispose fan-in → **rm**; `session_reset` / task-end / interrupt → **no** env dispose. Research: `docs/wayfinder/research-session-sticky-env-dispose-hooks.md`.

**Labels / ops (shipped):** component still `browser-sandbox` for janitor filter compatibility; also `myaipen.conversation_id`, `myaipen.expert_id`, `myaipen.seat_key` (and legacy `parent_task_id` = seatKey). Search by conversation/expert/seat. Janitor **rm** only expired product boxes **not** mapped as live sticky seats in this process (idle **stop** leaves map entry).

**Historical Spec #320:** parent-task key + task-end dispose — **superseded**; image pin / no Strix **kept**.

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

## 7. Install checklist (CyberStrike tool **classes** → L2 only)

Derived from `research/CyberStrikeAI/tools/` **categories**, not as first-class Node4 tools (shell-first / OMP). Use this when building or refreshing **pen-sandbox** packages. Prefer narrow installs; OSINT CLIs are optional and RoE-gated.

| Class (CyberStrike-style) | Example CLIs (install in image / host PATH) | Node4 usage |
|---------------------------|---------------------------------------------|-------------|
| Network scan | `nmap`, `masscan`, `rustscan` | `shell` |
| Web recon / fuzz | `ffuf`, `feroxbuster`, `gobuster`, `httpx`, `katana` | `shell` |
| Vuln templates | `nuclei` (+ templates volume), `wafw00f` | `shell` (nuclei-first for named products) |
| Injection assist | `sqlmap` | `shell` after manual signal |
| Subdomain / DNS | `subfinder`, `amass`, `dnsenum` | `shell` when surface-enum needs it |
| OSINT engines | FOFA/Zoomeye/Shodan **CLI or curl** (API keys in env) | `shell` + skill; **not** harness tools (see pentest-next-steps) |
| Service / postex | `redis-cli`, `impacket` helpers, `linpeas` | `shell` only if RoE `allow_postex` |
| Binary / CTF | `gdb`, `binwalk`, `strings` | CTF pack / lab only |
| Cloud / container | `trivy`, `prowler` | optional L2; not default MVP |
| Browser | Chrome + `agent-browser` in same **pen-sandbox** | `browser` tool |

**Not on this checklist as harness APIs:** 100+ YAML MCP tools (CyberStrike C1 excluded). Scanners missing from PATH → agent falls back; `doctor:pen-tools` reports degraded, non-gating.

**Current pen-sandbox core (must stay healthy):** `nuclei`, `nmap`, `sqlmap`, `ffuf`, `redis-cli`, browser stack. Expand by class only when lab gap list demands it.

---

## 8. One-line summary

**One first-party pen-sandbox for the pentest expert — shell and browser; browser image must be an explicit env pin (no Strix product default). Tooling health is optional observability, never a gate. Tool install lists are L2 checklists, not first-class agent tools.**
