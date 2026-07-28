# Research: honest internal-beta vuln-discovery capability bar

> Ticket: GitHub **#225** · Map **#151** (product CI/CD + internal beta single-server ship)  
> Repo primary sources only — **no new live LLM red-team**, no product feature code.  
> Date: 2026-07-28 · branch `research/internal-beta-vuln-capability` (base main `3378b8c`)

## Question

Against **primary sources in this repo** (docs, code contracts, and **in-tree** lab notes/scorecards), what can we **honestly claim** for internal beta about “digging vulnerabilities on a penetration target”?

Must answer:

1. Product path that is supposed to produce findings today  
2. `docs/v1-delivery.md` acceptance still unchecked vs done  
3. Lab/evidence already present (pass/fail/unknown + citations)  
4. Capability-honest one-paragraph statement for beta testers (and what **not** to claim)  
5. Gaps that block “finding lands in 漏洞台账” on a single-server beta host vs pure model quality risk  

**Out of scope (this ticket):** new live LLM runs; product fixes; #213 graph assembly.

---

## Executive answer

| Layer | Honest maturity |
|-------|-----------------|
| **Product design path (find → book → ledger)** | **Shipped in code/docs** — Expert seat + pentest pack + Expert Graph (`app_assessment` / `redteam_deep`) + `finding(confirm)` → `vuln_found` → platform 漏洞台账; chat is **not** product truth |
| **Standalone / lab discovery on Juice + DVWA (Node4 Hard Graph)** | **Pass (historical + tip workspaces)** — multi-finding, multi-class, evidence-backed bookings under authorized lab RoE; quality **varies** by model, stamp, and stage honesty |
| **Full product UI loop on a pilot host** (online Node + pack → whitelist target → finding on 漏洞页 + open evidence/report + interrupt/HITL) | **Still open in V1 acceptance** — three checklist rows remain unchecked with note **「需环境联调」** |
| **Coverage SLA / “find everything”** | **Explicitly not a product claim** — `docs/v1-delivery.md` §1 / §6; PRD lab note; AGENTS.md harness rules |

**One sentence for map #151 Cap-C:** We can honestly claim an **AI-assisted, session-driven Expert Graph path that has booked real multi-class findings on lab apps under Node4 standalone**, and a **designed platform ledger path** — but we **must not** claim a **verified end-to-end internal-beta UI loop** until the three `v1-delivery` env-联调 boxes are closed on a real host, and we **must not** claim scanner-class completeness or unattended red team.

---

## 1. Product path that is supposed to produce findings today

### 1.1 Intended user journey (V1 / PRD)

From `docs/v1-delivery.md` §2 / §5 and `docs/prd.md` §5–§6:

```text
Login → conversation (Agent main entry)
  → online Node4 bound to platform WS
  → default 工作台助手 (ledger assist only; no finding booking)
     OR @专家 / Mode with structured engagement (pentest)
  → Expert Graph via engagement template (app_assessment | redteam_deep)
     OR free OMP only for Default seat (Expert product UI has no free/OMP scene)
  → act tools (shell / http / session / browser / … via pen-sandbox when configured)
  → Finding Store candidates + feedback_ok
  → Main finding(confirm) with grounded proof
  → platform vuln_found → 漏洞台账 / evidence / optional report
  → harness task_complete
```

Install shape (`docs/v1-delivery.md` §5):

1. platform compose (db + rabbitmq + backend) + frontend  
2. Node4 host process — platform WS + **model API key**  
3. **pen-sandbox** image (shell/browser) — `docs/specs/pen-tools-sandbox.md`  
4. Node offers: install **pentest** pack; create Expert instance bound to Node  
5. User **creates asset (host)** first → session `@专家` → authorized scope test  

### 1.2 Seats, packs, graphs (who can dig)

| Surface | Books findings? | Work mode |
|---------|-----------------|-----------|
| Built-in **`default`** | **No** | Free OMP; platform citizen R/W ledger + report; no shell/finding |
| **`pentest` expert pack** | **Yes** (`bookingMode=finding`) | Product Expert Graph for templates below; act tools + finding |
| **`ctf` / other packs** | Pack-dependent | Not the primary “app pen test” DoD for V1 beta dig claim |
| Soft scenario Graph | **Retired** (#68 / #76) | Do not claim Soft as product dig path |

Product Expert Graph templates (`docs/specs/expert-offers.md`, `docs/wayfinder/research-multi-graphid-catalog-resolve.md`):

| Template | Pack | Product UI | RoE |
|----------|------|------------|-----|
| **`app_assessment`** | pentest | **Yes** (primary Mode sticky default) | `allow_postex: false` |
| **`redteam_deep`** | pentest | **Yes** (phase-2 deep) | `allow_postex: true` |
| `app_assessment_thin` | pentest | **Lab/CLI only** (not product Mode set) | thinner stage list |

Resolve chain (structured fields only — no NLP invent of engagement; AGENTS.md Intent rule):

```text
UI Mode / Case sticky engagement_template
  → platform task_assign (graph_execution full|continue)
  → Node resolveHardGraph + resolveExpertWorkPath
  → Hard Graph runner owns stage order; pi is in-stage Agent Runtime
```

Authority: ADR 0001 (`docs/adr/0001-graph-x-pi-product-path.md`) — unique product Node = **Node4 Graph × Pi**; Node5 deleted; Soft not product.

### 1.3 Booking → 漏洞台账 (product SOT)

From `docs/specs/harness.md`, `docs/specs/task-graph.md`, `docs/prd.md`:

- **Chat is not product truth** — vuln-grade conclusions only via `finding(confirm)` with grounded proof.  
- **Finding Store** is Store-first SoT for candidates; Main confirms with `finding_id` after `feedback_ok`.  
- Confirm emits **`vuln_found`** (and evidence) over platform WS → Case ledger / 漏洞页.  
- Sub packages **do not** book; Main books.  
- Host **does not** create asset IP/domain rows; user (or Authorize / next-scope) does.  
- Severity (Spec #139 D1): agent-assigned enum; Store preserve; fail-closed if missing/invalid — **no** silent `"medium"` product truth (historical collapse documented in `docs/wayfinder/research-severity-integrity-d1.md`).

### 1.4 Sandbox tools

`docs/specs/pen-tools-sandbox.md`: one image **`pen-sandbox`** for shell scanners (nuclei/nmap/sqlmap/ffuf/…) and browser (`agent-browser`). Map #151 charting lock: host Docker socket, not DinD first cut. Tooling health (`doctor:pen-tools`) is **observability only** — missing tools degrade probes but **do not** gate booking/settlement by code.

---

## 2. `docs/v1-delivery.md` acceptance — checked vs unchecked

Quoted from living checklist §7 (calibration note 2026-07-19; still current on main `3378b8c`):

### Done (`[x]`)

| Checkbox (verbatim gist) |
|--------------------------|
| 登录 → 默认进入 **会话**（Agent 主入口） |
| 侧栏 **状态看板**（`/dashboard`，在资产管理上方） |
| 漏洞页 query 深链（`?status=` / `?severity=`） |
| 任务计划 UI（`/schedules` + 手动 tick） |
| Logo / favicon / 登录左右分栏动效 / 右栏进入动效 |
| 本文档与 `platform/backend/.env.example`、`node4/.env.example` |
| 最小 CI：`.github/workflows/product-smoke.yml` |

### Still open (`[ ]` — all marked **需环境联调**)

| Checkbox (verbatim) |
|---------------------|
| 在线 Node + 专家包 → 对白名单目标执行 → finding 入漏洞页（需环境联调） |
| 证据可打开；报告可下载（需环境联调） |
| 可中断任务；高风险可授权卡（需环境联调） |

### Positioning already locked in the same doc (not checkboxes)

- §1: **是** AI 辅助工作台 / 会话驱动入账 / 台账报告看板；**不是** 无人值守全自动渗透 / 扫描器替代 / 「找全所有漏洞」。  
- §6 known limits: discovery quality varies; production risk needs written RoE; assets user-created; no official scoreboard SLA; schedules are retest/巡检 not unattended dig; token cost customer-owned.  
- §3 V1 不做: Goal maximize gates, multi-tenant SOC, answer keys, full K8s, etc.

**Implication for beta copy:** ship-of-UI shells and CI smoke are further along than the **single checked E2E dig→台账** row. Map #151 Cap-C correctly separates **Deploy-ready** from **Capability-honest** — capability failure degrades *copy*, not necessarily install.

---

## 3. Lab / evidence inventory (pass / fail / unknown)

**Rules used here:**  
- **Pass** = in-tree scorecard or lab report asserts completed/honest path with **booked findings ≥ 1** on that arm (or explicit process-honesty pass where discovery is separate).  
- **Fail / superseded** = invalid stamp, 0 book with known product bug later fixed, or blocked without discovery.  
- **Unknown** = designed path exists but **no** closed V1 env-联调 evidence for full platform UI→台账 on a beta host.  
- Lab never equals product SLA (PRD: labs are offline对照, not scoreboard gate).

### 3.1 Expert Graph Node4 — Juice Shop

| Evidence | Path | Result | Notes |
|----------|------|--------|-------|
| Hard vs Node5 Juice P1 | `benchmarks/hard-vs-node5/runs/20260724T003348Z/juice/scorecard.md` | **Pass (Juice P1)** | Mature Hard Graph Node4: terminal completed, **18** booked findings, multi-class; model deepseek-v4-flash; **Juice P1 pass? Y** |
| Juice discovery Hard thin (post-#57) | `benchmarks/juice-discovery/runs/20260723T200717Z/README.md` | **Pass (scoreable Hard)** | thin `app_assessment_thin` completed, **8** findings (~1016s) |
| Juice discovery first dual-arm Hard | `benchmarks/juice-discovery/runs/20260723T190830Z/scorecard.md` | **Fail@init (superseded)** | Hard thin **blocked@init**, **0** booked; Soft control **6** findings (control ≠ Hard claim) |
| Spec #139 tip dual-arm Juice | `node4/workspace/lab-139-dual/20260727-133709/logs/juice-report.md` + `dual-arm-verdict.md` | **Pass discovery / Partial process** | Mature `app_assessment`: **15** booked (crit3/high8/med2/low2); terminal **`blocked`** at `authz_logic` with **honest** booking-only tail (`process_complete=false`); process script 9/9 |
| OMP Juice historical | `benchmarks/omp-juice-20260719/` | **Reference only** | Pre-product-Hard / OMP-class density; **must not** re-badge as current product Soft or Hard (map C1 / wayfinder notes) |
| Early gap research (thin) | branch `research/hard-graph-juice-capability-gaps` (not on main living tree) | **Historical** | A-class gaps (book chain / no fan-out on thin) largely addressed by mature Hard + #69–#75 / #161 wave; do not treat as current floor |

### 3.2 Expert Graph Node4 — DVWA

| Evidence | Path | Result | Notes |
|----------|------|--------|-------|
| Hard vs Node5 DVWA P1 | `benchmarks/hard-vs-node5/runs/20260724T021339Z/dvwa/scorecard.md` | **Pass (DVWA P1)** | Mature Hard: **18** booked; injection/RCE/LFI/auth/CSRF/exposure; **DVWA P1 pass? Y**; prior stamp blocked@surface (INVALID) |
| Post-#161 validate_book completeness | `docs/wayfinder/lab-scorecard-process-discovery-164.md` + `node4/workspace/lab-161-dvwa/20260727-184104/logs/dvwa-report.md` | **Pass** | **10** booked; multi-severity crit3/high2/med3/low1/info1; validate_book executed with finding tools; process 9/9 |
| Tip dual-arm DVWA (pre-#161) | same dual stamp as Juice `20260727-133709` | **Fail booking (superseded)** | terminal completed but **0** booked / 14 unbookable residual — superseded by post-#161 re-run |
| OMP DVWA historical | `benchmarks/omp-dvwa-20260719/` | **Reference only** | Many class JSON findings; not product Graph authority |

### 3.3 Process / harness claims (not “N vulns SLA”)

| Source | Claim type | Verdict |
|--------|------------|---------|
| ADR 0001 B1 | Hard Graph Node4 reached **P1 parity** vs retired Node5 on Juice+DVWA | **Pass (historical decision)** — evidence under frozen `benchmarks/hard-vs-node5/` |
| `#164` scorecard process | Close-out, honesty, severity non-collapse, booked severity | Scriptable process checks **pass** on cited stamps; discovery multi-class remains **human offline** |
| Harness principles | No answer keys; findings alone ≠ job done; booking ≠ stop | **Product contract** — not a discovery yield guarantee |
| Collab playbook B | `benchmarks/collab-playbook-b/` | Multi-station handoff with findings artifacts — **collab/process lab**, not primary dig SLA |

### 3.4 Product UI → 漏洞台账 E2E

| Claim | Verdict |
|-------|---------|
| Code path exists (`vuln_found`, ledger UI, dedupe, rediscover) | **Designed/shipped** in product trees (`platform/` + `node4/` contracts in harness/task-graph/prd) |
| V1 acceptance “finding 入漏洞页” closed on pilot host | **Unknown / open** — checkbox still `[ ]` 需环境联调 |
| Evidence open + report download E2E | **Unknown / open** — same |
| Interrupt + high-risk authorize card E2E | **Unknown / open** — same |

### 3.5 What lab evidence does **not** prove

- That **every** beta tester run will book N findings.  
- Full OWASP Juice challenge scoreboard or DVWA module completeness.  
- Production SaaS target quality equal to DVWA/Juice lab.  
- That Default seat alone digs vulns (it does not book).  
- That Soft Graph is still a product mode (retired).  
- That Node5 is available (deleted; scorecards are frozen archaeology).

---

## 4. Recommended Capability-honest statement (beta testers)

### 4.1 One paragraph (Chinese — product voice aligned with `v1-delivery` §1/§6)

**推荐对内测用户话术：**

> 本产品是 **AI 辅助安全测试工作台**，不是无人值守全自动红队，也不是传统扫描器替代品。在 **工程师主导、书面授权与 Scope 白名单** 前提下，内测路径为：登录会话 → 在线 **Node4** → 安装并选择 **渗透专家（pentest）** → 使用结构化工作模式 **应用评估（`app_assessment`）**（或深度 **`redteam_deep`**）→ Agent 在沙箱工具中对目标做侦察与验证 → 经 **证据支撑的 finding 入账** 进入 **漏洞台账**（对话文本本身不算正式漏洞结论）。实验室离线对照（如 Juice Shop / DVWA 上的 Expert Graph 跑数）表明该路径 **能够发现并登记多类、多级别漏洞**，但 **发现数量与深度随模型、目标与当次会话波动**，需要人工复核；**不以官方 scoreboard 或「找全所有漏洞」为 SLA**。定时任务定位于复测/巡检，不是无人挖洞。当前 V1 验收仍保留「在线 Node + 专家包 → 白名单目标 → finding 入漏洞页」等 **环境联调** 项——内测阶段请以 **实际联调结果** 为准，并反馈断点（绑定、沙箱镜像、模型密钥、授权卡、台账展示）。

### 4.2 English short form (optional)

> Internal beta: AI-**assisted** session workbench on **Node4 Graph × Pi** with the **pentest** expert and **Expert Graph** templates (`app_assessment` / `redteam_deep`). Lab offline runs show multi-class, evidence-backed bookings on Juice/DVWA; quality varies by model and target; human review required. **Not** unattended red team, **not** a scanner replacement, **no** full-coverage SLA. Full UI→ledger E2E on the pilot host is still an open V1 env-integration checkbox.

### 4.3 What we must **not** claim

| Forbidden claim | Why |
|-----------------|-----|
| “Guarantees finding all / most vulns on any target” | Explicit anti-claim in `v1-delivery` §1/§6; no answer keys (AGENTS.md) |
| “Unattended full red team / set and forget dig” | Same; schedules are retest/巡检 |
| “Replaces commercial scanners / SOC” | §1 不是 |
| “Default 助手 will dig and book vulns” | default has **no** finding booking |
| “Soft Graph / Node5 still product paths” | Soft retired; Node5 deleted (ADR 0001 B1) |
| “OMP 2026-07-19 Juice folder = current product Soft control” | Frozen reference; map forbids re-badge |
| “V1 acceptance fully green including finding 入漏洞页” | Three env-联调 boxes still open |
| “Fixed N findings on every run / severity always perfect” | Lab variance; historical severity collapse risk; human review required |
| Target-specific profiles or challenge lists as product gates | AGENTS.md harness-over-restriction |

---

## 5. Gaps that block “finding lands in 漏洞台账” on a single-server beta host

Split **ops/config (blocks the pipe)** vs **model/process quality (pipe works, yield varies)**.

### 5.1 Ops / config / product integration (block or empty ledger independent of “model skill”)

| Gap | Why it blocks 台账 | Primary source |
|-----|-------------------|----------------|
| **Node4 not online / not bound** | No `task_assign` / no WS events | `v1-delivery` §5; `node4/.env.example` `PLATFORM_WS_URL`, `NODE_TOKEN` |
| **Missing model API key / wrong provider** | Stages never produce candidates | `node4/.env.example` `DEEPSEEK_API_KEY` / provider vars; §6 费用 |
| **pentest pack not installed / Expert not bound** | Expert dispatch blocked; only default (no book) | `docs/specs/expert-offers.md`; `experts/README.md` install CLI |
| **No user-created host asset / empty Scope** | Nothing to attach; agent must not invent hosts | `v1-delivery` §6.3; PRD asset rules |
| **No structured engagement / wrong seat** | Stuck on default; or free-in-envelope after complete without `graph_execution=full` | research multi-graphId / C1 continue; expert-offers templates |
| **pen-sandbox image missing / Docker socket unavailable** | Shell/browser probes degrade (doctor reports degraded); may yield thin recon → fewer books | `docs/specs/pen-tools-sandbox.md`; map #151 Pkg-D host socket |
| **RoE / authorize / out-of-scope** | High-risk or out-of-scope work refused or HITL wait; unapproved targets must not be hit | harness HITL tiers; `v1-delivery` §6.2 |
| **Platform secrets still lab defaults** | Auth/session failures, unsafe pilot | `v1-delivery` §5 生产前必改 `JWT_SECRET` / db / Node token |
| **V1 env-联调 not closed** | Product checklist still treats full dig→漏洞页 as **not** accepted | `v1-delivery` §7 three `[ ]` rows |
| **Evidence/report open path not verified on host** | Finding row may exist but “usable ledger” UX fails acceptance | same §7 |
| **Interrupt / authorize-card path not verified** | Long dig stuck or unsafe actions unmanaged | same §7 |
| **Network: target unreachable from sandbox/host** | Zero live surface → honest empty or block | lab runbooks require clean local targets |

Map #151 already lists related “not yet specified” ops: VPS size, pen-sandbox disk/pre-pull, whether lab targets share the beta host, secrets matrix, reverse proxy binary — these affect **whether** dig can run, not model IQ.

### 5.2 Model / agent quality risk (pipe up; results vary)

| Risk | Evidence of variance | Mitigation already in product posture |
|------|----------------------|----------------------------------------|
| **Zero or few bookings** despite live target | Pre-#161 DVWA 0 book; early thin Hard 0 book@init; Juice tip blocked mid-graph | Process honesty + booking tail; validate_book completeness #161; human review |
| **Class coverage gaps** | Juice P1: XSS/SSRF weak vs Node5 on some classes; “narrow” J1 | No SLA; optional deepen, not beta blocker for Cap-C honesty |
| **Duplicate / noisy titles** | Juice Hard near-dups noted in scorecard | Platform dedupe path∩stem; honest counts in work.md |
| **Severity quality** | Historical all-medium collapse if severity omitted | D1 fail-closed + Store preserve (research + harness text) |
| **Honesty mid-graph stop** | Juice 20260727 terminal `blocked` with 15 books still | `process_complete=false` honest residual; not silent green |
| **Token cost / long wall clock** | Hard Juice ~37m, DVWA ~46m in P1 scorecards | §6.6 customer monitors cost; not unattended |

### 5.3 Explicit non-blockers for Cap-C “can dig at all?”

- Completing every OWASP Juice challenge.  
- Shipping composable multi-graph assembly (#213).  
- Goal maximize / coverage state machine (V1 不做).  
- Phase B nightly Hard Graph CI (map: does not block first install).

---

## 6. Map #151 Cap-C recommendation

| Gate | Recommendation |
|------|----------------|
| **Deploy-ready** | Independent: login, bind Node, dispatch — may ship install while capability copy stays conservative |
| **Capability-honest** | Use §4.1 paragraph; cite lab **standalone** Pass + V1 **E2E unchecked** |
| **Go / no-go for “we dig vulns” marketing** | **Internal beta OK with caveats**; **not OK** to imply production-proven UI→台账 until three env-联调 boxes flip |
| **Failure mode** | If env-联调 fails: degrade **copy** and runbook, not necessarily block Cloudflare tunnel install (per map Cap-C) |

---

## 7. Sources consulted (primary)

| Area | Paths |
|------|-------|
| V1 ship | `docs/v1-delivery.md` |
| Product | `docs/prd.md`, `docs/adr/0001-graph-x-pi-product-path.md`, `AGENTS.md` |
| Harness / Graph | `docs/specs/harness.md`, `docs/specs/task-graph.md`, `docs/specs/expert-offers.md`, `docs/specs/pen-tools-sandbox.md` |
| Experts | `experts/README.md`, `experts/pentest/` (graphs hard ids via prior research) |
| Wayfinder | `docs/wayfinder/lab-scorecard-process-discovery-164.md`, `research-severity-integrity-d1.md`, `research-multi-graphid-catalog-resolve.md`, `hard-soft-juice-arm-invocation.md` |
| Frozen labs | `benchmarks/hard-vs-node5/`, `benchmarks/juice-discovery/`, `benchmarks/omp-juice-20260719/`, `benchmarks/omp-dvwa-20260719/` |
| Tip workspaces | `node4/workspace/lab-139-dual/20260727-133709/`, `node4/workspace/lab-161-dvwa/20260727-184104/` |
| Map context | GitHub #151 (parent), #225 (this ticket); resolution style of #214 |

---

## 8. Out of scope / not done here

- No new live LLM red-team or scorecard fill.  
- No product code, env flips, or checkbox edits in `v1-delivery.md`.  
- No edit to issue #151 body (parent Decisions so far).  
- No #213 compose implementation.

---

## 9. Suggested follow-ons (for other tickets — not this research)

1. **Env-联调 task** on the beta single host: close the three `v1-delivery` §7 open boxes with a recorded run (taskDir + screenshot 漏洞页).  
2. Optional: one **platform-path** lab stamp (not only standalone) frozen under ops notes — still offline score, no answer keys.  
3. Keep beta copy synced if post-联调 evidence upgrades “Unknown E2E” → Pass.
