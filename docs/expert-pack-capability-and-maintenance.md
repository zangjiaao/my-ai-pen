# Expert pack capability enhancement & long-term maintenance

**Status:** active living plan — **Phase A + B implemented** for `experts/pentest` (pack `1.1.1`: nuclei-first for named products; was `1.1.0` methodology+refs)  
**Primary pack in scope:** `experts/pentest` (patterns apply to other packs)  
**Research input:** `research/ClaudeBrain` (adapt methodology; do **not** vendor runtime)  
**Precedence:** `AGENTS.md` → `docs/prd.md` → `docs/node4-harness.md` → this plan  

**Implementation note:** Phase A (skill depth + work.md discipline) and Phase B (thin `refs/`, hot cards, version/CHANGELOG, L2 data-layer notes in CHANGELOG) shipped under `experts/pentest/`. Phase C (product intel query) remains optional/not started. Lab A/B metrics remain deferred.

---

## 1. Goals

| # | Goal | Success looks like |
|---|------|--------------------|
| **G1** | **Enhance current expert discovery quality** | Same authorized lab/target family: more evidence-backed findings, fewer empty loops, fewer unproven books — without answer keys or fixed vuln matrices |
| **G2** | **Sustainable long-term pack maintenance** | Clear layers for *what* to update when a new n-day/PoC appears; pack vs sandbox decoupled; changelog + install path; no wiki-sized knowledge dump in the system prompt |

**Non-goals (now):**

- Full ClaudeBrain-style 500+ page wiki + semantic search as a Node4 dependency  
- Keyword/regex routing of user prompts to skills (`triggers.json` pattern)  
- Mandatory coverage-class checklists as completion gates  
- Hardcoded target/CVE answer keys or product-specific exploit catalogs in mission  
- Remote pack marketplace / network hot-load (still out of scope; see `node-expert-offers.md`)

---

## 2. Problem framing

### 2.1 What limits discovery today

`experts/pentest` skills are correctly **hypothesis-driven and thin** (discipline over checklists), but many are light on **tactical depth**: test order, blind/OOB gates, dual-actor compare sequences, when to rotate, component fingerprint → verify loops. ClaudeBrain’s `hunt-*` skills are the opposite: dense playbooks wired to a wiki and Claude Code hooks.

Node4 already supplies the **execution surface** (shell, session, http, browser, finding, skill). The gap is mostly **methodology thickness + anti-loop discipline + n-day update path**, not a missing first-class scanner tool catalog.

### 2.2 The n-day / new-PoC question

When a new Fastjson (or other framework) issue appears, the agent must:

1. **Recognize** related assets from recon (fingerprint signals).  
2. **Know how** to pursue them (methodology).  
3. **Obtain current exploit/check material** from an **updatable** layer (templates, thin refs, optional query) — not from static mission text.  
4. **Prove** impact before booking; version age alone is not a finding.

That implies **three capability layers** (below), not a single “vulnerability database in the prompt.”

---

## 3. Capability layers (source of truth for updates)

```
L1  Expert pack          mission / work / skills / optional refs,recipes
    → judgment: when to test, process, evidence bar, dual path scanner vs hand PoC

L2  Sandbox / tool env   nuclei (bin + templates), sqlmap, ffuf, searchsploit, browser image, wordlists
    → weapons that can be refreshed without rewriting the pack

L3  Model + live PoC     session/http/script generation from observations + thin payload patterns
    → always available; must still meet proof gates
```

| Layer | Owns | Typical update trigger | Install / ship path |
|-------|------|------------------------|---------------------|
| **L1 pack** | Process, skill depth, hot component cards, payload *patterns* | New attack *class*, lab lessons, product RoE/templates | `experts/<id>` → `expert-cli install` → node install root |
| **L2 sandbox** | Binaries, nuclei-templates, wordlists, tool versions | New n-day *check*, new scanner version | Image tag and/or **data volume** (templates) synced separately |
| **L3 runtime model** | Improvisation on observed surface | Model upgrade (product choice) | Not pack versioning |

**Rule:** L1 and L2 **version independently**. A pack bump must not require a full image rebuild unless a new binary or PATH contract is introduced. Template freshness is an L2 ops concern.

---

## 4. What to take from ClaudeBrain (and what to refuse)

Source tree: `research/ClaudeBrain` (wiki, `skills/hunt/*`, hooks, `scripts/next_move.py`, engagement templates).

### 4.1 Adapt into packs (high value)

| ClaudeBrain idea | How we use it | Where it lands |
|------------------|---------------|----------------|
| Dense **hunt methodology** (test order, second-order, class-specific traps) | Rewrite short; no client data; no fixed target lists | `skills/pentest-*.md` |
| **Deadends / bounded abandon** | After bounded failure, record blocker, rotate vector | `work.md` + stuck-rotation / component skills |
| **State-first anti-loop** (don’t re-spray known fails) | Prefer Case findings + task notes; optional later Case fields | `work.md`; product Case later if needed |
| **OOB / proof gate for blind classes** | No inference-only books | injection / component skills |
| **Wiki-first payloads** as *optional thin refs* | Curated 5–20 patterns per class; agent `read` on demand | `experts/pentest/refs/` (new) |
| **Fingerprint → targeted test** | Not keyword prompt routing; from *observed* stack hints | `pentest-component-rce` + surface-enum |
| **learn / distill** (generic lessons only) | Human or PR process: lab lesson → skill/ref patch | Maintenance process §7 |

### 4.2 Do not port (conflicts with AGENTS / Node4)

| ClaudeBrain piece | Why not |
|-------------------|---------|
| `skills/hunt/triggers.json` + UserPromptSubmit keyword hooks | Violates **Intent And Workflow Selection** (no NLP/regex skill routing) |
| `coverage-classes.json` as mandatory complete matrix | Violates harness-over-restriction / no simulated coverage |
| Full `wiki/` + `qmd` MCP as default context | Token cost, wrong runtime, maintenance dump |
| `bootstrap.sh` into `~/.claude` | Claude Code-only harness |
| Client engagement under `targets/` model | We use Case + task cwd + finding booking |
| Per-product exploit catalogs in skills | Answer-key risk |

### 4.3 Research attribution

Record adaptations in `experts/RESEARCH-SOURCES.md` (pentest ← ClaudeBrain, adapted only).  
Do **not** import ClaudeBrain as a runtime dependency.

---

## 5. Enhancement plan (capability — G1)

Phased; each phase should be lab-checkable before the next.

### Phase A — Methodology depth (no wiki, no sandbox contract change)

**Objective:** Raise discovery quality for core Web/API classes and component patterns.

| Work item | Detail |
|-----------|--------|
| A1 | Thicken primary skills with ClaudeBrain-derived tactics (still hypothesis-driven): `web-recon`, `surface-enum`, `auth-session`, `sql-injection`, `xss`, `access-control`, `authz-logic`, `file-upload`, `component-rce`, `stuck-rotation` |
| A2 | `work.md`: deadend discipline, OOB/proof for blind issues, “at most one skill load”, scanner vs hand-PoC dual path pointer |
| A3 | Expand `pentest-component-rce`: fingerprint signals → check L2 tools / thin refs → bounded verify → book only with impact proof; **version ≠ finding** |
| A4 | Update `experts/RESEARCH-SOURCES.md` for ClaudeBrain |
| A5 | Lab A/B on existing authorized targets (e.g. DVWA / internal lab): compare confirmed findings, empty-loop turns, hollow books |

**Exit criteria:** Skill text remains short enough to load one-at-a-time; no CVE answer keys; lab shows directional improvement or clear residual gaps logged for Phase B.

### Phase B — Thin reference layer + n-day operator path

**Objective:** Support new PoCs without stuffing mission; support hand-rolled PoC with *some* material.

| Work item | Detail |
|-----------|--------|
| B1 | Add `experts/pentest/refs/` (optional `read` material): |
| | • `refs/payloads/<class>.md` — short pattern lists (sqli, xss, ssrf, upload, …) |
| | • `refs/components/<name>.md` — hot cards: fingerprint signals, attack *class*, suggested `nuclei` tags / searchsploit queries, 0–3 high-impact advisory pointers, `last_reviewed`, verification bar |
| B2 | Skills say: prefer observed surface → then `read` matching ref if needed → then L2 scanner with **narrowed** tags → else hand PoC |
| B3 | Document sandbox **data-layer** sync for nuclei-templates (and wordlists): prefer volume / startup update over full image rebuild |
| B4 | Operator runbook snippet in this doc §7 (new n-day day-of steps) |
| B5 | Seed 5–15 hot component cards (e.g. Fastjson, Log4j, Shiro, Actuator, common deserial) — patterns + query terms, not full exploit repos |

**Exit criteria:** A published n-day can be onboarded by updating L2 templates and/or one hot card **without** rewriting mission; agent path for “no nuclei hit” still has a hand-PoC pattern card where relevant.

### Phase C — Optional product intel (only if Phase B pain is real)

**Objective:** Query-by-fingerprint enrichment; never auto-finding.

| Work item | Detail |
|-----------|--------|
| C1 | Optional tool or shell convention: `intel` / OSV / local index query by component (+ version if known) |
| C2 | Report builder enrichment: attach CVE only when grounded in finding/evidence metadata; **do not invent CVE** when input has none |
| C3 | Explicit non-goal remains: dumping large CVE corpora into default system prompt |

**Exit criteria:** Query results are assistive; booking still requires live proof.

### Skill depth guidelines (all phases)

- **When to load** from *observed* signals only.  
- **Process** = ordered tactics, stop conditions, evidence shape.  
- **Do not** = invent endpoints, fixed vuln lists, version-only severity.  
- Prefer **patterns** (autoType, JNDI, UNION order) over paste of full weaponized chains when a public template exists in L2.  
- Payload samples in skills/refs: enough to orient; not a second PayloadsAllTheThings.

### Packs other than pentest

| Pack | Enhancement note |
|------|------------------|
| `ctf` | Keep challenge-oriented; optional ClaudeBrain CTF hunt ideas only if they don’t add answer keys |
| `llm-security` | Already has research sources; maintain via its own refs if needed |
| `code-audit` / `alert-triage` | Same L1/L2 split if tools appear; methodology from their RESEARCH-SOURCES |
| New packs (AD/cloud) | Prefer **new pack ids**, do not bloat `pentest` AppSec mission |

---

## 6. Hand-rolled PoC vs scanner (payload support)

Agents may skip nuclei (unknown templates, tool missing, logic bug, custom bypass). Capability must not depend on scanners alone.

| Path | Material | Update |
|------|----------|--------|
| **Scanner path** | L2 nuclei-templates / searchsploit | Ops template sync |
| **Hand PoC path** | L1 skill process + `refs/payloads` + `refs/components` + public advisory via shell | Pack refs / hot card |
| **Pure model invent** | Last resort | Must still differential/OOB prove; prefer deadend over speculative book |

**Payload support policy:**

1. **Yes**, hand PoC needs *thin* payload/pattern support for non-trivial and component classes.  
2. **No**, that support is not a full CVE wiki.  
3. Order: fingerprint → ref/tool material → generate/adapt → prove → book.  
4. Generated payloads without matching observation are low trust.

---

## 7. Long-term maintenance (G2)

### 7.1 Versioning

| Artifact | Version signal | Notes |
|----------|----------------|-------|
| Pack content | `pack.json` optional `"version": "semver"` (recommend introduce) + git tags `experts-pentest-x.y.z` | Semver: **major** mission/tool contract break; **minor** new skills/refs; **patch** methodology wording |
| Catalog | `experts/catalog.json` | Pack id/aliases only unless product needs versions later |
| Node install | Copy of pack at install time | Re-`install` after pack release to refresh worker |
| Sandbox image | Image tag `pen-tools:YYYY.MM.DD` or semver | Binaries + base OS |
| Templates / wordlists | Data stamp or git submodule SHA | May move without image rebuild |

Changelog: prefer `experts/pentest/CHANGELOG.md` (or monorepo root section) with one line per release: skills touched, refs added, L2 dependency notes (“needs nuclei-templates ≥ date”).

### 7.2 Who updates what (RACI-style)

| Event | L1 pack | L2 sandbox | L3 model |
|-------|---------|------------|----------|
| New **generic** technique (e.g. better SQLi order) | **Edit skill** | — | — |
| New **n-day** with public nuclei template | Optional hot-card pointer | **Sync templates** | — |
| New **n-day**, no template yet | **Hot card** + verify bar | Later when template exists | — |
| New **tool binary** required | Skill mentions how to invoke | **Image rebuild** | — |
| Lab false positive / hollow book | Skill proof bar | — | — |
| New engagement template / RoE | `work.md` / pack aliases | — | — |

### 7.3 Day-of runbook: new component vulnerability

1. Classify: scanner-detectable vs methodology-only vs needs new skill.  
2. If templates exist → update L2 data layer; smoke one known-safe lab URL.  
3. If not → add/update `refs/components/<name>.md` (`last_reviewed`, fingerprints, query terms, advisory links, proof bar).  
4. Touch `component-rce` (or class skill) **only if** the *process* changes.  
5. Do **not** put the full PoC chain into `mission.md`.  
6. Bump pack patch/minor; note L2 dependency in changelog.  
7. Re-install pack on lab node; run one engagement that fingerprints that stack.  
8. If reusable generic lesson (no client data) → fold into skill/ref in the same or follow-up PR.

### 7.4 Sandbox maintenance recommendations

- **Split image vs data:** stable tool image; frequently updated `nuclei-templates` (and wordlists) via volume, init container, or scheduled pull.  
- **Task start (optional later):** log template age or `nuclei -version` for observability — advisory, not a hard gate.  
- **Browser sandbox** (existing strix-sandbox class): independent of nuclei data; only bump when browser/tooling contract changes.  
- **RoE:** scanners remain in-scope only; no automatic out-of-scope expansion because a template matched a banner.

### 7.5 Pack install & distribution

Current model (unchanged):

- Source: `experts/<id>/`  
- Install: `npx tsx src/expert-cli.ts install <id>` → install root  
- Platform offers gate dispatch (`node-expert-offers.md`)

Maintenance implications:

- Workers only see **installed** copies; releasing to git is not enough without reinstall/sync.  
- Document operator step: “after pack release, reinstall on nodes that offer that pack.”  
- Future (out of scope now): signed pack bundles with version pin on offers.

### 7.6 Quality bar for every pack PR

- [ ] Aligns with `AGENTS.md` (no keyword intent routing, no answer keys, no fake coverage gates)  
- [ ] Skills still loadable as **assistive** methodology (not a mandatory matrix)  
- [ ] Finding path remains `finding(confirm)` + grounded proof  
- [ ] Docs: `RESEARCH-SOURCES` / this plan / pack README touch if behavior or process changed  
- [ ] Lab or smoke note when claiming discovery improvement  

### 7.7 Deprecation

- Remove or rewrite skills that encode stale product exploits as if universal.  
- Prefer hot-card `last_reviewed` stale → delete or mark superseded rather than infinite CVE lists.  
- Archived research under `research/` stays reference-only.

---

## 8. Mapping to repo layout (target)

```
experts/
  README.md                 # link this plan
  RESEARCH-SOURCES.md       # ClaudeBrain + others
  catalog.json
  pentest/
    pack.json               # + version field (Phase B+)
    mission.md
    work.md
    CHANGELOG.md            # recommended
    skills/…
    recipes/                # existing optional templates
    refs/                   # Phase B: payloads/ + components/
node4/                      # runtime only; does not vendor ClaudeBrain
docs/
  expert-pack-capability-and-maintenance.md  # this plan
  README.md                 # index link
```

Runtime remains `node4/` only. Trees `node/`, `node2/`, `node3/` stay non-expanding.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Skill bloat → token pressure | Cap skill length; move detail to on-demand `refs/` |
| Refs become de-facto answer keys | Patterns + query terms; proof required; no target-specific lists |
| Operators only update pack, forget templates | Changelog L2 dependency line; optional template-age log |
| Operators only update templates, agent never runs them | Phase A process: fingerprint → narrowed scanner tags |
| Keyword auto-skill from ClaudeBrain creeps in | Explicit refuse list §4.2; PR checklist |
| Coverage matrix as “done” signal | Forbidden as settlement gate; gaps may be *suggestions* only if ever implemented |

---

## 10. Success metrics (lightweight)

Use authorized lab baselines; do not hardcode expected vuln counts into the agent.

| Metric | Direction |
|--------|-----------|
| Confirmed findings with non-hollow proof | Up |
| Turns spent repeating the same failed probe family | Down |
| Books without grounded proof (caught in review) | Down |
| Time-to-onboard a new public n-day (ops clock) | Down (template and/or hot card only) |
| Pack reinstall + lab smoke after release | Process followed |

---

## 11. Immediate next steps (execution order)

1. ~~**Phase A** on `experts/pentest`~~ — done in pack `1.1.0`.  
2. ~~**Phase B** refs + hot cards + version/CHANGELOG~~ — done in pack `1.1.0`.  
3. ~~**Nuclei-first for named products**~~ — done in pack `1.1.1`.  
4. **Near-term roadmap (lab → gaps → optional OSINT):** see **[`pentest-next-steps.md`](pentest-next-steps.md)** (Phase L lab checklist, S sandbox hygiene, G gap patches, A2 FOFA/subdomain, C intel query, V versioning).  
5. Revisit product **intel_query** only if lab shows repeated component-intel pain.  
6. Keep this document updated when process or layout changes (living plan).  
7. After each pack release: re-`install` on nodes that offer `pentest`.

---

## 12. Related docs

| Doc | Role |
|-----|------|
| [`../AGENTS.md`](../AGENTS.md) | Engineering rules binding this plan |
| [`node4-harness.md`](node4-harness.md) | Runtime tools, booking, no finish tool |
| [`node-expert-offers.md`](node-expert-offers.md) | Install, offers, dispatch |
| [`../experts/README.md`](../experts/README.md) | Pack catalog layout |
| [`../experts/RESEARCH-SOURCES.md`](../experts/RESEARCH-SOURCES.md) | Research adaptation ledger |
| [`prd.md`](prd.md) | Product requirements |

---

## 13. One-line summary

**Enhance experts by thickening ClaudeBrain-class methodology inside skills and thin refs; maintain them by splitting pack judgment (L1) from updatable tools/templates (L2) and proof-gated hand PoCs (L3) — never by prompt-sized CVE wikis or keyword skill routers.**
