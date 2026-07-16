# Multi-expert collaboration & engagement plan

> **Status:** living plan (collaboration model **minimal**: Case + evidence + case_context + user @; no stations / structured handoff / Case disk)  
> **Precedence:** `AGENTS.md` → `prd.md` → this plan → other living docs  
> **Runtime:** `node4/` only. Pack content under `experts/`.  
> **Related:** `node-expert-offers.md`, `node4-harness.md`, `experts/README.md`, **`evidence-quality-plan.md`** (Case evidence Phases **A–E** tracker), research notes on Argo / DeepTeam / OMP (reference only).

---

## 1. Goal

Build a **red/blue security platform** where:

1. **Experts** are stable **target-family** specialists (what is tested + evidence shape), not kill-chain stage names.
2. **Collaboration** happens via **Case (= session 工作群) + shared findings/evidence + user @/选专家**, not a forced Agent stage machine and not a structured handoff protocol.
3. Two primary customer scenarios work on the **same application-security spine** with different **engagement / RoE depth**:
   - **Red-team deep:** external discovery → exploit → (optional) post-ex → lateral (in scope).
   - **App assessment:** customer-provided assets/accounts → surface + vulns + **authz/logic**; **no** webshell/privesc/lateral.
4. Future specialists (LLM security, code audit, alert triage, …) plug into the same Case model.

**Non-goals (explicit):**

- Default Node4 loop as fixed `recon → exploit → post-ex → report` state machine (Argo-style as agent brain).
- One Expert per phase (recon expert, foothold expert, lateral expert).
- NLP routing of free-text prompts to pick experts/workflows (`AGENTS.md`).
- Hardcoded CVE answer keys or mandatory vulnerability matrices as the default path.

---

## 2. Principles (decision rules)

| Principle | Meaning |
|-----------|---------|
| Expert = target family | Distinct surface + tools + evidence + methodology book |
| Stage = skill / todo | Recon, foothold, lateral live **inside** a pack |
| Pipeline = Case work group | Same conversation: chat + findings/evidence + `case_context` on dispatch |
| In-loop freedom = OMP | Each expert burst: Map → Act → Book; density over gates |
| Intent = structured | `engagement` / Expert instance / user @ — not keyword NLP invent of pack |
| Harness over restriction | Prefer pack prompts, envelope, skills; not new default validators |

**Expert vs skill test:**

> Would a user open a session and **only @ this name** for a complete job?  
> - Yes → Expert (pack)  
> - Only a step inside another job → skill

---

## 3. Target scenarios (acceptance stories)

### 3.1 Scenario A — Red-team style (deep)

1. Discover surface via external intel (e.g. Shodan-class), nmap, SSL/certs, domains, crawling/API enumeration; record sensitive findings.
2. Single and combined exploits (e.g. weak login → Fastjson / upload → webshell).
3. Host control → privesc, persistence, cleanup (in RoE) → internal lateral.

**Expert spine:** Application security (primary).  
**Depth:** Engagement `redteam_deep` (name TBD) enables post-ex / lateral skills.  
**Not required:** separate recon/foothold/lateral Experts.

### 3.2 Scenario B — Pre-prod app assessment

1. Customer supplies host IP, Web URL, test accounts.
2. Port scan + Web/API surface (bounded to provided assets).
3. Conventional vulns + **authz/logic** (e.g. IDOR).
4. **No** webshell, privesc, persistence, lateral.

**Expert spine:** Same application security Expert.  
**Depth:** Engagement `app_assessment` disables post-ex skills and forbids host takeover in RoE text + policy.

---

## 4. Expert family (catalog packs)

Display names are product-facing; pack ids are stable technical ids.

| Display family (example) | Pack id | Specializes in | Evidence center | Status |
|--------------------------|---------|----------------|-----------------|--------|
| 应用安全评估 | `pentest` | Live Web/API/app services (incl. framework/middleware as skills) | HTTP/shell PoC | **Exists** — extend |
| CTF | `ctf` | Challenge / flags | Flag + evidence | **Exists** |
| 安全咨询 | `consult` | Explain/analyze; no product findings | Chat | **Exists** (stub) |
| 模型与 Agent 安全 | `llm-security` (TBD) | LLM/RAG/tool-calling agents | Transcripts, tool-call logs, judge+proof | **Planned** (DeepTeam as research input) |
| 代码安全评估 | `code-audit` (TBD) | Source/repo static review | Code locations, static findings | **Planned** (Argo ideas for artifacts/validate) |
| 告警研判 | `alert-triage` (TBD) | SIEM/alerts/logs (blue/purple) | Alert fields, timelines | **Planned** |
| 威胁情报 | `threat-intel` (TBD) | Intel-only delivery | Intel brief | **Optional** — default as skill under app assessment |
| 网络与主机行动 | `network-ops` (TBD) | Post-foothold host/internal (if split from app) | Host/shell, lateral path | **Optional later** — v1 = skills under `pentest` |

### 4.1 Naming rules

- Prefer **「目标物 + 工作性质」** (应用安全评估、模型与 Agent 安全、代码安全评估、告警研判).
- Use **红队 / 渗透** as engagement **depth or package marketing**, not as the only Expert name axis.
- Do **not** name Experts after stages: 侦察 / 打点 / 横向 / webshell.

### 4.2 What stays inside `pentest` (not new Experts)

| Topic | Placement |
|-------|-----------|
| Fastjson, Log4j, Shiro, upload RCE | Skills under `pentest` |
| Redis / DB exposure, SQLi via app | Skills under `pentest` |
| nmap, crawl, certs, API map | Recon / surface skills |
| Weak password (bounded) | Auth skill + RoE |
| Webshell → privesc → lateral | Post-ex skills; **engagement-gated** |
| External intel (Shodan-class) | Skill `external-intel` or optional `threat-intel` pack |

---

## 5. Skills roadmap (application security spine)

Existing `experts/pentest/skills/` today:

- `pentest-web-recon`, `pentest-auth-session`, `pentest-sql-injection`, `pentest-xss`, `pentest-access-control`, `pentest-file-upload`, `pentest-stuck-rotation`

### 5.1 Add / extend (priority order)

| Skill id (proposed) | Covers | Scenario A | Scenario B |
|---------------------|--------|------------|------------|
| `pentest-surface-enum` | Ports, certs, domains, crawl, API inventory, sensitive data notes | Required | Required (scoped) |
| `pentest-external-intel` | Passive discovery (Shodan-class, public assets) — methodology only, no answer keys | Strong | Optional |
| `pentest-component-rce` | Framework/middleware patterns (deser, JNDI, known class — **hypothesis-driven**, not CVE keys) | Strong | As needed |
| `pentest-service-exposure` | Redis/DB/ES/etc. unauth/misconfig on exposed services | Strong | As needed |
| `pentest-authz-logic` | Horizontal/vertical IDOR, multi-account compare (strengthen existing access-control) | As needed | **Primary** |
| `pentest-postex-host` | Webshell/session host control, privesc, persistence, cleanup — **RoE gated** | On in deep | **Off** |
| `pentest-lateral` | Internal recon/lateral after foothold — **RoE gated** | On in deep | **Off** |

CTF / consult: keep separate; do not dump red-team post-ex into CTF.

### 5.2 Planned packs — skill sketches (not exhaustive)

**`llm-security` (DeepTeam as research reference):**

- Attack skills: single-turn injection/jailbreak patterns; multi-turn (crescendo/tree) as methodology.
- Risk skills: prompt/PII leakage, tool orchestration abuse, goal theft, excessive agency.
- Eval skill: judge criteria + **require capturable transcript/tool evidence** before booking.
- Framework mapping skill: OWASP LLM / agentic labels for reports (not mandatory coverage gate).

**`code-audit` (Argo-inspired artifacts, not forced stages):**

- Recon-of-repo / focus split as **skills**.
- Optional adversarial validate skill on candidates.
- Booking: code location + proof excerpt; optional chat suggestion that app security runtime-verify.

**`alert-triage`:**

- Alert enrichment, true/false positive, detection gap vs red-team PoC (purple).
- Evidence: alert payload + linked finding ids.

---

## 6. Platform collaboration model (minimal)

### 6.0 Glossary (converged — avoid parallel protocols)

| Term | Meaning |
|------|---------|
| **Case = Session** | One conversation = one work group. No separate Case graph in v1. |
| **Shared on Case** | Chat thread, **findings**, **evidence** (paths/ids included), RoE/target sticky. |
| **`case_context`** | Implementation detail: on each `task_assign`, inject a **trimmed read of the Case** (thread + findings board + path hints from evidence/chat) so the expert is not amnesic. Not a second product object. |
| **Cross-expert suggestion** | Agent **writes in chat** that another expert should continue (e.g. “建议拉 code-audit 看源码”). User `@` / selects expert. **No required structured handoff API.** |
| **Stations** | **Out of product scope** — no station UI/protocol required. |
| **Case shared disk** | **Not required** — dump source / notes as **evidence** (or chat path); Case-shared evidence + `case_context` is enough for the next expert. |
| **Structured handoff API / banner** | **Not part of the collaboration model.** Legacy code may exist; do not build product flows on it. Prefer chat suggestion + user `@`. |

### 6.1 Case (案件)

**v1 decision (locked): 1 Conversation (session) = 1 Case.**

- Platform **conversation** is the Case: scope, RoE, engagement template, messages, findings, evidence.
- Many Node **tasks** and many **@Experts** inside that same chat.
- Multi-conversation per Case: out of scope for v1.

Minimal fields:

| Field | Role |
|-------|------|
| Case identity | `conversation_id` |
| `scope` / RoE | Assets, bans (e.g. no post-ex) |
| `engagement_template` | `app_assessment` \| `redteam_deep` \| … (structured) |
| Shared truth | Messages + findings + evidence (conversation-scoped) |

### 6.2 How experts collaborate (the only path)

```text
1. User + Expert A work in the Case (chat + tools + finding/evidence booking)
2. Expert A may say in chat: “建议 @code-audit / 应用安全 做 …”
3. User selects the other expert (toolbar / @) — no silent pack switch, no NLP invent
4. task_assign carries case_context (read the group: thread + findings + evidence path hints)
5. Expert B continues from Case state — not from a blank mind or a mandatory HANDOFF.md ritual
```

**Evidence as shared materials:** source dumps, notes, screenshots should be **booked or linked as evidence** (or clearly stated in chat). Next expert sees them via Case findings/evidence + `case_context` hints — **not** via a separate Case filesystem product.

**Evidence quality is a hard prerequisite.** Phases **A–E** live in [`evidence-quality-plan.md`](evidence-quality-plan.md). **Book-time model (current):** act tools do not flood Case; each `finding(confirm)` creates linked Case proof from agent `proof` (grounded in recent tool output). Joining experts read `case_context` findings + proof snippets — not prior `taskDir`. Optional: include source path snippets in `proof` when code-audit needs materials.

### 6.3 Engagement templates (RoE depth only)

| Template | Maps to scenarios | Post-ex | Notes |
|----------|-------------------|--------|-------|
| `app_assessment` | B | Off | Customer assets/accounts; authz/logic focus |
| `redteam_deep` | A | On (in scope) | External discovery + chain + optional lateral |

Optional labels like `ai_app` / `purple_team` are **engagement/RoE or pack choice**, not station machines.

Envelope: `engagement`, `scope`, RoE flags, accounts, targets, **`case_context`**.

---

## 7. Node4 runtime work (supporting, not stage machine)

| Item | Purpose |
|------|---------|
| Pass RoE / engagement into task envelope + prompt | Scenario B bans post-ex in agent context |
| **`case_context` on assign** | Work-group read: thread + findings board |
| Proof-first booking | Product truth |
| OMP todo hygiene | Live map |
| Subagent batch | Large separable packages only |

Do **not**: kill-chain state machine; required structured handoff; stations as gates; Case shared-disk product.

---

## 8. Implementation phases (for goal execution)

### Phase 0 — Docs & contracts (this doc + index)

- [x] Commit prior OMP todo / pack-boundary work  
- [x] Publish this plan; link from `docs/README.md`, `experts/README.md`  
- [x] Update `node-expert-offers.md` with expert family table + engagement templates (short pointer)

### Phase 1 — Engagement + RoE for two scenarios

- [x] Platform: engagement templates `app_assessment` / `redteam_deep` (UI or API)  
- [x] Task envelope: targets, accounts, `allow_postex`, ban list  
- [x] Node4: inject RoE into prompt from envelope  
- [x] `experts/pentest/work.md`: document both scenarios and skill loading rules  

**Exit:** Scenario B can be started with assets/accounts and post-ex disabled in prompt; Scenario A can enable deep path in prompt.

### Phase 2 — Skills expansion (`pentest`)

- [x] Add skills in §5.1 (at least surface-enum, authz-logic strengthen, postex-host + lateral stubs gated)  
- [x] Component/service skills without CVE answer keys  
- [x] `pack.json` skill list + catalog  

**Exit:** Agent can load methodology for surface → exploit → (optional) post-ex without new Experts.

### Phase 3 — Case collaboration MVP (= one conversation)

- [x] Treat each conversation as one Case; Case fields on conversation  
- [x] Findings/evidence conversation-scoped (shared across experts in that chat)  
- [x] User @ / expert select (structured pack from Expert instance — not NLP)  
- [x] **`case_context` on task_assign** (thread + findings board)  
- [ ] ~~Structured handoff API as product path~~ — **dropped from model** (chat suggestion only)  
- [ ] ~~Stations UI~~ — **dropped from model**  
- [ ] ~~Case shared disk~~ — **dropped**; use evidence + paths in Case  

**Exit:** Two Experts in the same Case share chat + findings/evidence; joining expert reads `case_context`.

### Phase 4 — New packs (order by product need)

1. [x] `llm-security` scaffold (pack.json, mission, work, 2–3 skills; DeepTeam as research only)  
2. [x] `code-audit` scaffold (static focus; optional validate skill)  
3. [x] `alert-triage` scaffold (purple with red findings)  
4. [ ] Optional `threat-intel` only if intel-only product SKU exists  
5. [x] Research enrichment wave: methodology skills adapted from `research/AI-Red-Teaming-Guide`, `research/deepteam`, `research/argo` (see `experts/RESEARCH-SOURCES.md`) — not vendored runtimes  

**Exit:** Installable packs + Expert instances; not required for Scenario A/B spine.

### Phase 5 — Subagent + optional validate

- [ ] Batch/parallel subagent for large separable surfaces  
- [ ] Optional validate expert/subagent on candidates only  
- [x] Purple methodology skills (optional chat suggestions toward alert-triage); not a stations/handoff product  

**Exit:** Large targets can fan-out; quality path optional; small DVWA-class stays single-agent dense.

### Phase 6 — Network-ops split (only if needed)

- [ ] If post-ex/lateral methodology outgrows app pack, extract `network-ops`  
- [x] No stations product; do not create stage Experts  

---

## 9. Gap coverage review

| Gap (from design discussions) | Covered by | Phase | Residual risk |
|-------------------------------|------------|-------|----------------|
| Scenario A kill chain without stage Experts | Engagement deep + postex/lateral skills | 1–2 | Tooling/sandbox policy for post-ex must be productized carefully |
| Scenario B no webshell/privesc | RoE flags + engagement + work.md | 1 | Enforcement is prompt/policy first; hard deny-lists for commands are optional later and must not be target-specific hacks |
| Surface discovery (nmap/certs/crawl/API) | `pentest-surface-enum` (+ external-intel) | 2 | Quality depends on model + skill text, not a scanner product rewrite |
| Fastjson/Log4j/framework | `pentest-component-rce` skill | 2 | No CVE answer keys — residual “misses” OK |
| Redis/DB exposure | `pentest-service-exposure` | 2 | Same |
| Authz/logic focus | Strengthen access-control / authz-logic | 2 | Multi-account harness may need session actor patterns (already partly in pack) |
| Multi-expert collaboration | Case + evidence + case_context + user @ | 3 | Keep evidence booking quality; no handoff/stations product |
| LLM app testing | `llm-security` pack | 4 | Not in Scenario A/B spine; intentional |
| Code audit | `code-audit` pack | 4 | Suggest pentest for runtime verify via chat + evidence |
| Blue/purple alerts | `alert-triage` + purple template | 4–5 | |
| Subagent underuse on small targets | Document “single-slice stay main” | docs | OK |
| Subagent value on large targets | Phase 5 batch return contract | 5 | |
| Proof quality | Proof-first booking (shipped) | done | Keep enforcing |
| Todo batch-flip | OMP mid-run todo (shipped) | done | |
| Over-restriction / pipeline prison | Explicit non-goals; no stations product | all | Review any new gate in PR |
| Intent routing abuse | Structured engagement / user @ only | all | |

### 9.1 Coverage verdict

| Scenario | Plan coverage | Blockers to “done” |
|----------|---------------|--------------------|
| **B App assessment** | **High** after Phase 1–2 | Envelope RoE + authz skills |
| **A Red-team deep** | **Medium–high** after Phase 1–2; stronger with post-ex skill quality | Post-ex skill content + legal/RoE UX; optional network-ops later |
| **Multi-expert Case** | **Lower** after case_context | Evidence quality + user @; no handoff/stations product |
| **LLM / code / alert** | **Scaffolded** in Phase 4 | Separate product priority |

**Conclusion:** The plan **covers both painted scenarios** on one application-security Expert with engagement depth. Collaboration is **Case chat + findings/evidence + case_context + user @** — not stations, shared disk, or structured handoff. New Experts are **target families**, not kill-chain steps.

---

## 10. Success metrics (lightweight)

| Metric | Intent |
|--------|--------|
| Scenario B runs never book host post-ex findings when `allow_postex=false` | RoE works |
| Scenario A can complete surface → exploit → (if allowed) post-ex notes with evidence | Deep path works |
| Small single-app runs keep low subagent rate | No forced fan-out |
| Other expert only after explicit user @ / select | No silent pack switch |
| No new default stage state machine in Node4 continue policy | Harness integrity |

---

## 11. Research mapping (do not implement as defaults)

| Research | Use |
|----------|-----|
| OMP | In-loop density, todo hygiene, multi-slice subagent only when parallel |
| Argo | Case evidence patterns, optional validate-after-candidates (no stations product) |
| DeepTeam | `llm-security` skill/attack/judge **content** only |

---

## 12. Doc maintenance

When implementing:

- Update this plan checkboxes or split completed phases into living specs (`node-expert-offers.md`, `experts/README.md`, `prd.md` slices).
- Keep `AGENTS.md` rules; do not reintroduce keyword engagement inventing or vuln-matrix default gates.

---

## 13. Suggested goal prompts (implementation)

### 13.1 Single goal: Phase 1 → 4 (recommended when using one long goal)

Use this when you want **one** goal run covering the full collaboration spine through new pack scaffolds. Execute **in order**; do not skip ahead to packs before RoE/envelope works.

> Implement `docs/multi-expert-collaboration-plan.md` **Phases 1 through 4** in order.  
>  
> **Case (v1):** 1 conversation = 1 case (no multi-session case). Shared findings/evidence stay conversation-scoped. Multiple Node tasks and @Experts may run inside that one session.  
>  
> **Phase 1 — Engagement + RoE**  
> - Structured engagement templates at least `app_assessment` and `redteam_deep` (UI and/or API + task envelope).  
> - Envelope fields: targets, accounts, scope, `allow_postex` (or equivalent RoE flags).  
> - Node4 injects engagement + RoE into the agent prompt; defaults conservative (`app_assessment` / post-ex off when unset).  
> - Do **not** invent engagement via NLP or target identification (no DVWA-specific engagement).  
>  
> **Phase 2 — `experts/pentest` skills**  
> - Add/expand skills per plan §5.1: surface-enum, external-intel (methodology), component-rce, service-exposure, authz-logic (strengthen), postex-host + lateral **gated by engagement/RoE**.  
> - Update `pack.json`, catalog, `work.md` for both scenarios A/B. No CVE answer keys.  
>  
> **Phase 3 — Case collaboration MVP**  
> - Case-shaped fields on conversation; findings/evidence shared; `case_context` on assign.  
> - User `@` / expert select (no silent pack switch; no required structured handoff).  
>  
> **Phase 4 — New packs (scaffold)**  
> - Create installable packs: `llm-security`, `code-audit`, and `alert-triage` (mission/work/skills stubs + `pack.json` + catalog).  
> - Content may reference DeepTeam/Argo **ideas** only; do not vendor those codebases or add kill-chain Experts.  
>  
> **Hard constraints:** No default kill-chain state machine in Node4 continue policy. No stage-named Experts (recon/foothold/lateral/host/network as separate experts). No NLP engagement routing. Keep docs living: this plan checkboxes, `node-expert-offers.md`, `experts/README.md`, `docs/prd.md` as needed.  
>  
> **Done when:** (1) app_assessment vs redteam_deep change prompt/RoE behavior; (2) pentest skills listed and loadable; (3) same Case shares findings/evidence + case_context; (4) three new packs install via expert-cli / catalog.

### 13.2 Split goals (if the single goal is too large)

**Goal A — Phase 1 + 2 only:**

> Implement plan Phase 1 then 2 only (engagement/RoE + pentest skills). Case remains 1 conversation = 1 case. No kill-chain state machine; no NLP engagement.

**Goal B — Phase 3 only:**

> Implement Phase 3: Case fields on conversation, case_context, user @ (no stations/structured handoff product). 1 session = 1 case.

**Goal C — Phase 4 only:**

> Scaffold `llm-security`, `code-audit`, `alert-triage` packs per plan §4–5; catalog + install.
