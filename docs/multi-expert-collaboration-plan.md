# Multi-expert collaboration & engagement plan

> **Status:** planning (implementation driven by goal / follow-up PRs)  
> **Precedence:** `AGENTS.md` → `prd.md` → this plan → other living docs  
> **Runtime:** `node4/` only. Pack content under `experts/`.  
> **Related:** `node-expert-offers.md`, `node4-harness.md`, `experts/README.md`, research notes on Argo / DeepTeam / OMP (reference only).

---

## 1. Goal

Build a **red/blue security platform** where:

1. **Experts** are stable **target-family** specialists (what is tested + evidence shape), not kill-chain stage names.
2. **Collaboration** happens via **Case (案件) + shared artifacts + explicit handoff/@**, not a forced Agent stage machine.
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
| Pipeline = Case workflow | Stations + artifacts + handoffs on the **platform** |
| In-loop freedom = OMP | Each expert burst: Map → Act → Book; density over gates |
| Intent = structured | `engagement` / Expert instance / handoff payload — not keyword NLP |
| Harness over restriction | Prefer pack prompts, envelope, skills; not new default validators |

**Expert vs skill test:**

> Would a user open a session and **only @ this name** for a complete job?  
> - Yes → Expert (pack)  
> - Only a step inside another job → skill (or station content)

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
- Booking: code location + proof excerpt; optional handoff to app assessment for runtime verify.

**`alert-triage`:**

- Alert enrichment, true/false positive, detection gap vs red-team PoC (purple).
- Evidence: alert payload + linked finding ids.

---

## 6. Platform collaboration model (the “pipeline”)

### 6.1 Case (案件)

Minimal fields (design target):

| Field | Role |
|-------|------|
| `case_id` / conversation linkage | Shared home for artifacts |
| `scope` / RoE | Assets, bans (e.g. no post-ex) |
| `engagement_template` | `app_assessment` \| `redteam_deep` \| `ai_app` \| `purple_team` \| … |
| `stations[]` | Soft workflow UI state |
| `participants` | Expert instances involved |
| Artifacts | surface, intel, candidates, findings, alerts, code notes |

v1 may **evolve conversation** into Case-shaped metadata rather than a greenfield product if cheaper — behavior matters more than table name.

### 6.2 Stations (工位) — soft pipeline

Example stations (template-selected, not Agent tool gates):

| Station | Default Expert | Artifacts |
|---------|----------------|-----------|
| Scope & intel | App assessment (+ intel skill) | `intel_brief`, scope |
| External surface | App assessment | `surface_map` |
| Exploit / verify | App assessment | candidates + proof findings |
| Host / internal (optional) | App assessment post-ex skills | host notes, lateral path |
| Model & Agent (optional) | `llm-security` | LLM test evidence |
| Code (optional) | `code-audit` | code findings |
| Detection (optional) | `alert-triage` | alert verdicts |
| Delivery | App assessment / consult | report |

**Station transitions:** platform UI + explicit handoff; **never** NLP auto-advance.

### 6.3 Handoff (结构化交接)

```text
suggest_expert_pack: llm-security
reason: "Primary surface is chat+tools API"
artifact_ids: [...]
```

User confirms or one-click `@Expert`. Platform must not silently switch pack from free text.

### 6.4 Engagement templates

| Template | Maps to scenarios | Post-ex | Notes |
|----------|-------------------|--------|--------|
| `app_assessment` | B | Off | Customer IP/URL/accounts; logic/authz focus |
| `redteam_deep` | A | On (in scope) | External discovery + chain + optional lateral |
| `ai_app` | Hybrid | Off/default | App assessment + station for llm-security |
| `purple_team` | Hybrid | Off | Exploit then alert-triage |
| `code_then_runtime` | Hybrid | Off | code-audit → app verify handoff |

Envelope must carry: `engagement`, `scope`, **RoE flags** (e.g. `allow_postex: false`), accounts, targets.

---

## 7. Node4 runtime work (supporting, not stage machine)

| Item | Purpose |
|------|---------|
| Pass RoE / engagement flags into task envelope + system prompt | Scenario B bans post-ex in agent context |
| Proof-first booking (done / maintain) | Product truth for both scenarios |
| OMP todo hygiene (done / maintain) | Live map; categories from pack |
| Subagent batch + structured return | Large separable packages only |
| Optional validate path | Follow candidates; never first post-recon workstream |
| Handoff event type (optional) | `expert_handoff_suggested` for UI |

Do **not**: implement kill-chain state machine as default continue policy.

---

## 8. Implementation phases (for goal execution)

### Phase 0 — Docs & contracts (this doc + index)

- [x] Commit prior OMP todo / pack-boundary work  
- [ ] Publish this plan; link from `docs/README.md`, `experts/README.md`  
- [ ] Update `node-expert-offers.md` with expert family table + engagement templates (short pointer)

### Phase 1 — Engagement + RoE for two scenarios

- [ ] Platform: engagement templates `app_assessment` / `redteam_deep` (UI or API)  
- [ ] Task envelope: targets, accounts, `allow_postex`, ban list  
- [ ] Node4: inject RoE into prompt from envelope  
- [ ] `experts/pentest/work.md`: document both scenarios and skill loading rules  

**Exit:** Scenario B can be started with assets/accounts and post-ex disabled in prompt; Scenario A can enable deep path in prompt.

### Phase 2 — Skills expansion (`pentest`)

- [ ] Add skills in §5.1 (at least surface-enum, authz-logic strengthen, postex-host + lateral stubs gated)  
- [ ] Component/service skills without CVE answer keys  
- [ ] `pack.json` skill list + catalog  

**Exit:** Agent can load methodology for surface → exploit → (optional) post-ex without new Experts.

### Phase 3 — Case collaboration MVP

- [ ] Case-linked artifacts (or conversation-level artifact index)  
- [ ] Structured handoff suggestion + UI one-click @  
- [ ] Soft stations on Case UI (display + suggest only)  

**Exit:** Two Experts can work same Case with shared findings/evidence; handoff is explicit.

### Phase 4 — New packs (order by product need)

1. [ ] `llm-security` scaffold (pack.json, mission, work, 2–3 skills; DeepTeam as research only)  
2. [ ] `code-audit` scaffold (static focus; optional validate skill)  
3. [ ] `alert-triage` scaffold (purple with red findings)  
4. [ ] Optional `threat-intel` only if intel-only product SKU exists  

**Exit:** Installable packs + Expert instances; not required for Scenario A/B spine.

### Phase 5 — Subagent + optional validate

- [ ] Batch/parallel subagent for large separable surfaces  
- [ ] Optional validate expert/subagent on candidates only  
- [ ] Purple template: exploit → alert-triage  

**Exit:** Large targets can fan-out; quality path optional; small DVWA-class stays single-agent dense.

### Phase 6 — Network-ops split (only if needed)

- [ ] If post-ex/lateral methodology outgrows app pack, extract `network-ops`  
- [ ] Keep stations; do not create stage Experts  

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
| Multi-expert collaboration | Case + artifacts + handoff | 3 | Needs platform work beyond chat @ |
| LLM app testing | `llm-security` pack | 4 | Not in Scenario A/B spine; intentional |
| Code audit | `code-audit` pack | 4 | Optional handoff to runtime verify |
| Blue/purple alerts | `alert-triage` + purple template | 4–5 | |
| Subagent underuse on small targets | Document “single-slice stay main” | docs | OK |
| Subagent value on large targets | Phase 5 batch return contract | 5 | |
| Proof quality | Proof-first booking (shipped) | done | Keep enforcing |
| Todo batch-flip | OMP mid-run todo (shipped) | done | |
| Over-restriction / pipeline prison | Explicit non-goals; stations soft | all | Review any new gate in PR |
| Intent routing abuse | Structured engagement/handoff only | all | |

### 9.1 Coverage verdict

| Scenario | Plan coverage | Blockers to “done” |
|----------|---------------|--------------------|
| **B App assessment** | **High** after Phase 1–2 | Envelope RoE + authz skills |
| **A Red-team deep** | **Medium–high** after Phase 1–2; stronger with post-ex skill quality | Post-ex skill content + legal/RoE UX; optional network-ops later |
| **Multi-expert Case** | **Medium** after Phase 3 | Platform Case/handoff implementation |
| **LLM / code / alert** | **Scaffolded** in Phase 4 | Separate product priority |

**Conclusion:** The plan **covers both painted scenarios** on one application-security Expert with engagement depth. Collaboration gaps are **platform Case/handoff**, not missing stage Experts. New Experts are **target families**, not kill-chain steps.

---

## 10. Success metrics (lightweight)

| Metric | Intent |
|--------|--------|
| Scenario B runs never book host post-ex findings when `allow_postex=false` | RoE works |
| Scenario A can complete surface → exploit → (if allowed) post-ex notes with evidence | Deep path works |
| Small single-app runs keep low subagent rate | No forced fan-out |
| Handoff to llm-security only after explicit user/platform action | No silent pack switch |
| No new default stage state machine in Node4 continue policy | Harness integrity |

---

## 11. Research mapping (do not implement as defaults)

| Research | Use |
|----------|-----|
| OMP | In-loop density, todo hygiene, multi-slice subagent only when parallel |
| Argo | Case artifacts, optional validate-after-candidates, soft stations |
| DeepTeam | `llm-security` skill/attack/judge **content** only |

---

## 12. Doc maintenance

When implementing:

- Update this plan checkboxes or split completed phases into living specs (`node-expert-offers.md`, `experts/README.md`, `prd.md` slices).
- Keep `AGENTS.md` rules; do not reintroduce keyword engagement inventing or vuln-matrix default gates.

---

## 13. Suggested goal prompt (for later implementation)

> Implement `docs/multi-expert-collaboration-plan.md` Phase 1 then Phase 2: engagement templates + RoE envelope into Node4 prompts; expand `experts/pentest` skills for surface-enum, authz-logic, gated postex/lateral; update living docs. Do not add a default kill-chain state machine. Do not add stage-named Experts.
