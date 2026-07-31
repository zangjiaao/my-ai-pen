# Research: Black-cat architecture fact model

> Ticket: GitHub **#262** · Map **#261** (Black-cat vs platform — contrast and learnings)  
> Primary sources: local `research/Black-cat/**` only (upstream mirror of [0rangec3t/Black-cat](https://github.com/0rangec3t/Black-cat)).  
> Date: 2026-07-31  
> Scope: **facts only** — what Black-cat *is* as a documented runtime model. No adopt/reject product advice.

## Question

What is **Black-cat** (`research/Black-cat`) **actually** as a runtime model — layers, control flow, work-state source of truth, hypothesis–evidence rules, context discipline — and what do its own sources support saying it is **not**?

## Executive answer (facts)

| Dimension | As documented |
|-----------|----------------|
| Host form | **Claude Code skill** (`name: pentest-redteam`), not a standalone orchestrator process or multi-tenant platform |
| Drive model | **Hypothesis-first** (signal → hypothesis → prove/disprove), not tool-first pipeline |
| Control flow | **Attack state machine with back-edges** in `SKILL.md` L2 |
| Domain content | **Six technique markdown files** loaded by **explicit signal routing** |
| Long-run SOT | **Workspace `./engagement-tracker.md`** (Engagement mode only); Focused mode uses no tracker |
| Evidence | Confirmed findings require **Observation → Reproduction → Impact** under `evidence/{id}/` |
| Context | Active technique files **default 1, max 2**; templates and other domains **not preloaded** |

---

## 1. Primary-source inventory

| Path | Role |
|------|------|
| `research/Black-cat/README.md` | Product framing: hypothesis–evidence, state machine vs pipeline contrast, architecture diagram (L1/L2/L3 + techniques + tracker), file tree, technique coverage catalog, install/use as Claude Code skill |
| `research/Black-cat/skills/pentest-redteam/SKILL.md` | Skill frontmatter + L1-style rules (auth, modes, routing, context, evidence/budget hard constraints) + **L2** attack state machine + decision-gate triggers (~99 lines; README calls it “98 行”) |
| `research/Black-cat/skills/pentest-redteam/techniques/{web,ad,cloud,database,evasion,reversing}.md` | Domain **signal → hypothesis → verify → prove/disprove → escalate** checklists (L3 content in practice) |
| `research/Black-cat/skills/pentest-redteam/templates/engagement-tracker.md` | Copy-into-workspace runtime tracker template (seven zones + Meta) |
| `research/Black-cat/skills/pentest-redteam/templates/finding-report.md` | Single-finding report skeleton |
| `research/Black-cat/skills/pentest-redteam/templates/engagement-report.md` | Final engagement report skeleton (loaded only at REPORT) |
| `research/Black-cat/assets/*` | Branding image only |

**Absent in this tree (honest gaps):** no executable orchestrator, no agent-runtime code, no multi-agent protocol, no database schema, no “blackboard” / Knowledge Source terminology, no automated stage runner beyond skill text interpreted by Claude Code.

---

## 2. Layers (README architecture + SKILL + techniques + templates)

### 2.1 Three-layer stack (README)

`research/Black-cat/README.md` draws:

```text
SKILL.md
  L1: 7 个强制约束
  L2: 有回边的 State Machine + Decision Gates
  L3: 信号 → 动作链
techniques/ (6 files; 显式文件路由; 默认 1、最多 2)
Engagement Tracker (运行时唯一真相源)
  ⚡ Active → ✅ Confirmed / ❌ Killed
  evidence/{id}/
```

### 2.2 What `SKILL.md` actually contains

Frontmatter (`research/Black-cat/skills/pentest-redteam/SKILL.md`):

- `name: pentest-redteam`
- `description`: authorized red-team hypothesis-driven framework; explicit route to one technique file; active directories default 1, max 2
- `allowed-tools: Read,Grep,Glob,Bash,WebFetch,WebSearch`

Body sections (no separate `## L1` / `## L3` headings; only **`## L2：Attack State Machine`** is labeled):

| Section | Content gist |
|---------|----------------|
| Authorization Gate | Four questions before first target entry (scope doc, depth limits, time/blue-team, egress/cleanup/data); re-ask only when scope changes; pause if out of scope |
| Mode selection | **Focused validation** (default) vs **Engagement mode** |
| Explicit routing | Signal → one of six technique paths |
| Context constraints | Active technique count, no preload of templates/other domains, min-repro tool preference |
| Hard constraints | Evidence Chain + hypothesis/budget/cleanup rules (cross-mode) |
| L2 state machine | States, min outputs, exit/back-edge rules |
| Decision Gates | When to log options/choice/why |

**L1 note:** README asserts “L1: 7 个强制约束.” `SKILL.md` does **not** number seven L1 items; hard rules are distributed across auth, modes, routing, context, evidence chain, and hypothesis/budget. Fact: treat “L1” as the non-L2 skill constraints block; the count “7” is README wording, not a labeled list in `SKILL.md`.

**L3 note:** README places **L3 = 信号 → 动作链** under `SKILL.md`, but `SKILL.md` has **no L3 section**. The same chain shape appears as the **per-entry structure of technique files** (see §2.3). Operationally, L3 content lives in `techniques/*.md`.

### 2.3 Technique files (domain L3 content)

Six files under `research/Black-cat/skills/pentest-redteam/techniques/`:

| File | Frontmatter name | Trigger (from SKILL routing table / file header) |
|------|------------------|--------------------------------------------------|
| `web.md` | `pentest-web` | Domain/CDN/frontend/Web/API/GraphQL/WebSocket |
| `cloud.md` | `pentest-cloud` | AWS/Azure/GCP/K8s/containers |
| `database.md` | `pentest-database` | DB ports / connection strings |
| `reversing.md` | `pentest-reversing` | APK/IPA/EXE/firmware |
| `ad.md` | `pentest-ad` | AD/internal/credentials — **only explicit authorized internal tasks** |
| `evasion.md` | `pentest-evasion` | EDR/evasion/OPSEC — **only explicit adversarial-validation tasks** |

Common technique-file pattern (headers + entries; example structure from `web.md` / `cloud.md` / etc.):

- Guard line: read **only after** root routing selects this directory; each entry is a **hypothesis to verify** with first-hand evidence
- Domain “决策直觉” short principles
- Entries shaped as: **信号 → 假设 → 验证 → 证实 (and often 证伪) → 升级**
- Some entries add OPSEC notes or multi-step “验证管线”

`ad.md` and `evasion.md` restate that they must **not** be broadly auto-triggered (matches SKILL routing).

### 2.4 Templates

| Template | When used (per SKILL) | Purpose |
|----------|----------------------|---------|
| `templates/engagement-tracker.md` | Engagement mode: **copy** to workspace `./engagement-tracker.md`; do not edit the template itself | Runtime SOT for long assessments |
| `templates/finding-report.md` | Finding output format (not gated to a named stage in SKILL; structure aligns with evidence chain) | Single finding: hypothesis, reproduction, evidence table, impact, verification statement, cleanup |
| `templates/engagement-report.md` | **Only at REPORT** stage | Final report skeleton: scope/budget, attack surface, hypotheses/decisions, confirmed, inconclusive/ruled-out, evidence index, cleanup, deferred |

---

## 3. Control flow — attack state machine, gates, back-edges

### 3.1 Graph (SKILL L2)

```text
IDLE → RECON ⇄ ENUMERATE ⇄ VALIDATE → EXPLOIT → POST-EXPLOIT → REPORT
                  ↑            │            │            │
                  └────────────┴────────────┴────────────┘
                         新信号、证伪、失败或新目标
```

Source: `research/Black-cat/skills/pentest-redteam/SKILL.md` (L2 diagram).

### 3.2 Per-state minimums and exit/back rules

| State | Minimum output | Exit / back |
|-------|----------------|-------------|
| IDLE | Auth, scope, time budget (Auth Gate) | Scope confirmed → RECON |
| RECON | Tracker init (engagement); Attack Surface zone incremental update | Signal present → ENUMERATE; else continue RECON |
| ENUMERATE | Active zone ≥ **2** items (signal + disprove condition + priority) | Pick candidate → VALIDATE; no candidates → RECON |
| VALIDATE | Independent evidence; hypothesis → Confirmed or Killed; write `evidence/{id}/` | Prove → EXPLOIT; disprove → update tracker and **back** |
| EXPLOIT | Full Evidence Chain + Cleanup zone init | Success → POST-EXPLOIT; failure → **BRANCH RE-EVAL** (Decision Log) |
| POST-EXPLOIT | New asset/privilege evidence + Cleanup update + restart RECON on new target | New target → RECON; done → REPORT |
| REPORT | All Confirmed have full Evidence Chain; all Cleanup items confirmed | Report complete |

Back-edge drivers named on the diagram: **new signals, disprove, failure, or new targets**. Lateral success on a new host restarts **RECON** (README + POST-EXPLOIT row).

### 3.3 Decision Gates

Each gate records in tracker **Decisions** zone: options, choice, why.

Trigger points (`SKILL.md`):

1. After initial RECON  
2. After each VALIDATE conclusion (Active → Confirmed or Killed)  
3. After EXPLOIT success or failure  
4. At time budget **80% / 50% / 20%**  
5. On new attack surface (new host/domain/cloud identity)  
6. When an Active hypothesis has **3 consecutive OODA rounds** with no progress  

**OODA:** referenced for tracker incremental updates and the 3-round defer rule; **not defined** as a formal subprocess elsewhere in the tree.

### 3.4 Contrast claimed vs market skills (README)

| Dimension | Market skills (as README frames them) | Black-cat |
|-----------|--------------------------------------|-----------|
| Drive | Tool-first (phase → run nmap, etc.) | Hypothesis-first |
| Flow | One-way pipeline | State machine with back-edges |
| Failure | Skip to next phase | Disprove yields new hypothesis |
| Evidence | Isolated screenshots | Traceable Observation → Reproduction → Impact |
| Target switch | Unsupported | State-machine restart (new segment → new RECON) |
| Runtime tracking | None or scattered | Single Engagement Tracker |
| Context | Load everything | Explicit file routing; 1–2 techniques |
| Cleanup | None | Cleanup Ledger |
| Decisions | Implicit | Explicit Decision Log at gates |

---

## 4. Work state SOT — tracker zones; Focused vs Engagement

### 4.1 Modes (`SKILL.md` §2)

| Mode | When | Tracker | Technique load | Output shape |
|------|------|---------|----------------|--------------|
| **Focused validation (default)** | One target / one hypothesis | **Do not initialize tracker** | Root-route one technique → execute | `observation → reproduction → impact` in-reply |
| **Engagement mode** | Multi-asset, long assessment | Create workspace `./engagement-tracker.md` from template; **runtime sole source of truth** | One technique at a time; second only on **confirmed** cross-domain dependency | Tracker zones + evidence dirs; report template only at REPORT |

Engagement mode: each OODA cycle **appends** to tracker zones; **does not rewrite** the document wholesale.

### 4.2 Tracker zones (`templates/engagement-tracker.md`)

**Meta:** Scope, time budget used/%, risk level (`stealth` / `standard` / `aggressive`), current state (IDLE…REPORT), active techniques (max 2), last updated, evidence dir `evidence/`.

| Zone | Role |
|------|------|
| ⚡ **Active** | Candidates under test; each row: Priority, Hypothesis, Signal, Test, **Prove if**, **Disprove if**, Round, Time/Risk |
| ✅ **Confirmed** | Independent evidence; pointer to `evidence/{id}/`; tree sketch 01-observation / 02-reproduction / 03-impact + Verdict CONFIRMED |
| ❌ **Killed** | Disproved; keep why + **Would revisit if**; do not delete |
| 📋 **Deferred** | 3 rounds no new evidence; revisit trigger |
| 📡 **Attack Surface** | Confirmed assets/services/identities; incremental append |
| 🧹 **Cleanup** | Artifacts to clean; REPORT requires each ✅ |
| 📝 **Decisions** | Gate log: Time, Gate, Options, Chose, Why |

SKILL lists the same seven operational zones: Active / Confirmed / Killed / Deferred / Attack Surface / Cleanup / Decisions.

---

## 5. Hypothesis–evidence model

### 5.1 Prove / disprove rules (`SKILL.md` hard constraints)

- **Do not invent** exploitability/impact scores before validation; score after verification.
- **Disprove ≠ failure:** move hypothesis to **Killed**, record revisit conditions; **do not delete**.
- Active hypothesis: **3 OODA rounds** without new progress → **Deferred** with revisit conditions.
- Time at **80%** or single-path timeout → **BRANCH RE-EVAL** in Decision Log.
- First creatable cleanup artifact (files/accounts/creds/config/deployments/persistence) enables Cleanup ledger; confirm all before REPORT.

### 5.2 Evidence chain

- Every Confirmed finding must trace **raw observation → reproduction action → impact proof**.
- Files under `evidence/{id}/` with three artifacts (observation / reproduction / impact). Tracker example names: `01-observation.txt`, `02-repro.sh`, `03-impact.png` (illustrative extensions in template).
- Without independent evidence → status **`inconclusive` only**; must not enter Confirmed.

### 5.3 Verification mode

On entering VALIDATE, agent must declare (exact string in SKILL and `finding-report.md`):

> `I am now in verification mode: assume false positive until independent evidence proves otherwise.`

Finding report statuses: `confirmed` / `inconclusive` / `ruled_out` (template vocabulary; tracker uses Confirmed / Killed for the hypothesis queue).

### 5.4 Technique-level prove path

Technique entries operationalize the same loop at checklist granularity (signal/hypothesis/verify/prove/disprove/escalate), feeding ENUMERATE Active rows and VALIDATE outcomes when Engagement mode is on.

---

## 6. Context discipline

From `SKILL.md` §3–4 and README:

| Rule | Fact |
|------|------|
| Routing | By **asset signal**, read **one** technique file; **no broad pre-read** |
| Active technique count | **Default 1, max 2** in a single context |
| Second technique | Only when **confirmed** cross-domain dependency (Engagement); unload unrelated technique content before loading the second |
| Restricted auto-route | `ad.md`, `evasion.md`: large / context-invasive; **no broad automatic trigger** — only explicit matching authorized tasks |
| Templates | **Not preloaded**; load when their stage arrives (report template only at REPORT) |
| Other domains | **Not preloaded** |
| Tools | Prefer tools that **minimally reproduce**; aggressive tools need authorization basis |
| Allowed tools (skill) | Read, Grep, Glob, Bash, WebFetch, WebSearch (frontmatter); technique frontmatter often omits WebSearch |

Install/use path (README): install via Claude Code from the GitHub URL; invoke `/skill pentest-redteam` or describe a target so the skill matches techniques by signal. Authorization: authorized testing only.

---

## 7. What it is not (only where sources support negation)

Supported by explicit contrast or by **absence + stated form**:

| Claim | Support |
|-------|---------|
| **Not a one-way pipeline** | README: market skills = Pipeline; this skill = State Machine with back-edges |
| **Not tool-first phase binding** | README: tool-first vs hypothesis-first |
| **Not “load all techniques/context”** | README + SKILL: explicit routing; default 1 / max 2; no preload of templates/other domains |
| **Not a tracker for single-hypothesis focused work** | SKILL: Focused mode **does not** initialize the tracker |
| **Not an editable-in-place template SOT** | Tracker template is **copied** to workspace; template file itself must not be the live SOT |
| **Not a multi-process product platform / multi-tenant app** | Tree is skill markdown + templates + assets; README use model is Claude Code skill install/invoke only |
| **Not an automated Graph/stage runner binary** | No runner code in tree; control flow is **documented state machine for the LLM skill** |

**Not claimed by sources (do not assert as Black-cat design):** classic multi–Knowledge-Source blackboard architecture, multi-agent captain/worker graph, product Finding Store, or host-owned stage settlement. Those terms do not appear under `research/Black-cat/**`.

---

## 8. Gaps / inconsistencies inside the sources

1. **L3 placement:** README puts L3 inside SKILL.md; SKILL.md has no L3 heading — technique files carry the signal→action content.  
2. **“L1: 7 constraints”:** README number is not mirrored as a seven-item list in SKILL.md.  
3. **Line count:** README “SKILL.md (98 行)” vs local file **99** lines.  
4. **OODA** used operationally without a definition section.  
5. **Status vocabulary:** tracker Killed vs finding-report `ruled_out`; both mean disproved/excluded with record kept.  
6. **No machine-enforced gates:** gates, max techniques, and verification statement are **skill instructions** to the model, not code assertions in this repo snapshot.

---

## Summary

Black-cat, as mirrored under `research/Black-cat`, is a **Claude Code red-team skill** whose runtime model is: (1) a thin **SKILL.md** of authorization, dual modes, explicit technique routing, context caps, and evidence/budget hard rules; (2) an **L2 attack state machine** (IDLE→…→REPORT) with **back-edges** and **Decision Gates** logged to a tracker; (3) **six on-demand technique** files that implement **signal→hypothesis→verify→prove/disprove→escalate** content; (4) in **Engagement** mode only, a workspace **Engagement Tracker** as sole work-state SOT (Active/Confirmed/Killed/Deferred/Attack Surface/Cleanup/Decisions) plus `evidence/{id}/` chains and late-loaded report templates. **Focused** mode skips the tracker and returns a single observation→reproduction→impact chain. Context is deliberately sparse (≤2 techniques, no preload). It is explicitly **not** a linear tool pipeline; the sources do **not** describe a multi-agent blackboard product or a code-enforced graph runner.
)
