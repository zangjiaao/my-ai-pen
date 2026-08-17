# Research: stage-intent boundaries without answer keys (surface vs deep probe)

> Ticket: GitHub **#144** · Map **#140** · Feeds Spec **#139**  
> Repo sources only (no product code in this resolution).  
> Date: 2026-07-27

## Question

How should Expert Graph enforce **professional stage intent** —

- **`surface`** = recon / surface-ledger deposit + **bounded smoke**
- **`class_probe`+** = hypothesis-driven multi-class exploit depth

— **without** fixed module lists, expected finding counts, or crippling agent judgment?

## Executive answer

**Recommend I5 (hybrid): I1 stage-intent prompts + existing I2 tool profiles + light I4 stage-scoped candidate semantics; reject I3 as primary.**

| Option | Name | Verdict |
|--------|------|---------|
| **I1** | Prompt-only stage intent | Necessary, not sufficient alone |
| **I2** | Tool-profile limits | Keep and **document as intent boundary** (already partial) |
| **I3** | Quota-smelling heuristics | **Reject as primary** (answer-key adjacent) |
| **I4** | Stage-scoped candidates | **Adopt lightly** (opportunistic smoke OK; not required; not multi-class gate) |
| **I5** | Hybrid (I1+I2+light I4) | **Primary design** |

Host already owns stage Feedback from Product state (Finding Store + package terminals + surface ledger) with **no expected-finding counts**. Intent should ride that spine: **steer the agent’s decision path**, fail-closed only on **structure** (`surfaces_min`, honesty), soft-signal process metrics only for **probe-like** empty yield — never for “did you hit SQLi on surface.”

---

## 1. Primary-source inventory (what exists today)

### 1.1 Mature Expert Graph stages (`experts/pentest/graphs/hard/app_assessment.json`)

| Stage | `success` (gist) | `require` | Act tools | Agent Graph | Booking |
|-------|------------------|-----------|-----------|-------------|---------|
| `init` | Understand target/RoE; **no live recon** | `summary` | none (todo/read/fact/skill/write) | no | no |
| **`surface`** | ≥1 live surface from recon (API/auth/file/client) | **`summary` + `surfaces_min: 1`** | shell/http/session/browser/script | **no `subagent`** | **no `finding`** |
| `auth_session` | Login/session characterized; auth candidates or deadends | `summary` | full act | **subagent** | no finding |
| **`class_probe`** | Multi-class hypothesis probe; packages when multi-class justified; **no package quota**; plan_node_id L2 | `summary` only | full act | **subagent** | no finding |
| `authz_logic` / `component` | Dual-actor / named-component depth | `summary` | full act | subagent | no finding |
| `validate_book` | Confirm `feedback_ok` via `finding_id` | `summary` | **finding only** (no shell/subagent) | no | **yes** |

Thin lab graph (`app_assessment_thin.json`) collapses to init → surface → class_probe → validate_book with the same surface gate pattern.

**Structural facts:**

- Surface is already **tool-profile bounded**: no fan-out packages, no booking channel.
- Surface is **not** candidate-gated (`candidates_min` exists in the type system but is **unused** on product graphs).
- Class_probe success text already bans fixed package quotas and micro-spawn; prefers packages when **this run’s recon** justifies multi-class work.

### 1.2 Stage prompts (`node4/src/runtime/hard-graph-stage-executor.ts`)

`stageSystemPrompt` / `stageUserPrompt`:

- Inject `Stage success criteria: ${stage.success}` and “Complete **only this stage**.”
- Host-settlement law (Spec #125): no `result.json` handoff; surfaces via `fact(op=surface)`; Store candidates via packages or `finding(upsert)`.
- When `subagent` allowed: prefer packages, no hard quotas, anti-micro-spawn.
- When **not** allowed (includes **surface**): still says deposit candidates via `finding(upsert)` — **but `finding` is not on the surface allowlist**. Prompt/tool mismatch: surface cannot legally deposit Store candidates today.

Contract tests (`hard-graph-stage-prompts.test.ts`): narration + prefer-packages; **no fixed package counts**; **no target answer-key names**.

### 1.3 Surface ledger + `surfaces_min`

| Piece | Behavior |
|-------|----------|
| Ledger path | `taskDir/surfaces/ledger.json` (`SurfaceLedgerStore`) |
| Deposit | `fact(op=surface, location=…)` or package `surfaces[]` → `upsertFromRecon` |
| Status flow | `open` → `in_probe` → `probed` \| `booked` \| `deadend` \| `skipped_roe` |
| Gate | `evaluateStageGate`: fail if ledger/host surfaces length `< surfaces_min` |
| Host projection | `settleHostStage` reads **ledger** for surfaces (agent `result.json` ignored) |
| Todo gate | Graph `todo(done)` blocked while open/in_probe remain (coverage honesty) |

`surfaces_min: 1` is a **structure** gate (live recon happened), not a quality or class matrix.

### 1.4 Process quality / discovery breadth (`experts/pentest/work.md`)

Bans (Expert Graph / Spec #116):

- Fixed must-test module lists, expected vuln counts, answer keys, hard fanout quotas.
- Progress as tool-arg dumps (“Next: Running…”).

Requires:

- Packages when multi-class work is justified by **this run’s recon** (judgment).
- Serial Main allowed if Feedback accepts.
- Discovery breadth: todo complete ≠ engagement complete; do not invent modules absent from recon; do not stop solely because “enough findings.”
- Bounded abandon / rotate after deadend (anti-loop) — effort-bounded, not quota-to-N.

### 1.5 Stage continuity (`docs/specs/task-graph.md`)

- Per-stage pi workdirs; **handoff contract is host settlement** (Store + packages + surface ledger).
- Process Feedback: structure fails, discovery-yield soft-fails, `surface_acted_rate`, fanout package attempts — **no expected-finding counts**.
- Settlement does **not** require N bookings.
- Handoff snapshot in the stage prompt is **informational**; booking authority is Store + groundable observations.

### 1.6 Discovery yield (`hard-graph-feedback.ts`)

`evaluateDiscoveryYield`: soft-fail when **probe-like** stage (`class_probe` / authz / auth_session / component) has **rich surfaces** (≥3) and produces **neither new candidates nor deadends**.

- Applies to empty monologue risk on **probe** stages.
- **Does not** soft-fail `surface` for zero candidates (correct: surface success is inventory, not exploit yield).

### 1.7 Session / lab evidence (problem shape)

Hard mature DVWA scorecard (`benchmarks/hard-vs-node5/…/dvwa/scorecard.md`): after surface fix, **surface accepted ~24 locations**; **class_probe** did multi-class; **validate_book** booked SQLi/RCE/LFI/CSRF/config — professional split when inventory is rich.

Residual failure mode the ticket names:

> Surface already produced CI/SQLi candidates; multi-class fan-out later in class_probe.

Interpretation (Product-state, not answer keys):

1. **Attention burn:** surface stage has full act tools, so Main can deep-grind one sink (e.g. CI/SQLi) for many turns while ledger still thin → **breadth debt** for later stages.
2. **Narrative candidates without Store:** surface cannot `finding(upsert)` / package; “candidates” often live in prose/summary only — weak handoff, waste of stage budget.
3. **Intent collapse:** success string says “live surface recorded” but does **not** name bounded smoke vs multi-class campaign; agent fills ambiguity with early exploit.

Node5 lab histories show multi-class **packages** under `class_probe/*` — product Expert Graph should keep that **depth home** in class_probe+, not in surface.

---

## 2. What “enforce stage intent” must mean here

Per `AGENTS.md` / harness-over-restriction:

| Allowed | Forbidden |
|---------|-----------|
| Stage success text + prompts that state professional phase intent | Fixed OWASP/module must-test lists |
| Tool profiles that remove **channels** (no book / no fan-out on surface) | Expected vulnerability counts or class quotas |
| Structure gates on **Product state** (ledger surfaces ≥1) | Target-specific profiles / site IDs |
| Soft process metrics on empty probe yield | Keyword “intent detection” inventing engagement |
| Agent judgment for which classes to open from **observed recon** | Crippling shell/http so recon cannot smoke |

**Intent is phase professional discipline, not correctness of which vulns exist.**

---

## 3. Operational definition: **bounded smoke** (no target lists)

### 3.1 Definition

**Bounded smoke** (surface-stage act) is a **short live check** that a **recon-observed** surface is real enough to warrant later methodology depth:

| Dimension | Bounded smoke | Deep probe (class_probe+) |
|-----------|---------------|---------------------------|
| **Goal** | Inventory + characterize (method, params, auth need, stack hints, reachability) | Prove / deadend **attack-class hypotheses** with proof_excerpt or honest abandon |
| **Trigger** | Location **seen** in HTML/JS/response (not imagined checklist) | Open ledger path + L2 attack-class / package from **this run’s** map |
| **Effort** | Few differential requests **per observed surface/param family** | Methodology skill depth, multi-payload families, dual-actor, nuclei-narrow, OOB wait, etc. |
| **Stop** | Surface deposited; live/auth/error shape noted **or** honest non-reachable | Candidate with proof **or** deadend after bounded abandon (work.md) |
| **Yield** | Surfaces (required structure); **opportunistic** single-shot candidate OK | Multi-class candidates/deadends; prefer packages when multi-class |
| **Not** | Full class matrix; payload library walk; multi-class serial campaign; package fan-out | Re-doing pure inventory as substitute for act |

### 3.2 Positive examples (target-agnostic)

- GET/HEAD entry URL; note redirects, auth wall, tech headers.
- Enumerate forms/links/API paths **from responses**; `fact(op=surface)` each observed location with kind/params/auth.
- One benign probe that distinguishes “parameter reflects / errors / needs auth” — then **record and move on** to unmapped surfaces.
- Session login **only as far as** establishing whether auth exists for later `auth_session` (characterization), not full dual-actor matrix (that is `authz_logic`).

### 3.3 Negative examples (still not module lists)

- Loading injection → XSS → SSRF → upload skills in series **before** ledger is broad.
- Grinding the same param family through many payloads after first differential already known.
- Spawning multi-class packages (blocked by tool profile — reinforce in prompts).
- Stopping recon because one opportunistic CI/SQLi looked strong (“enough findings” — banned by work.md).
- Inventing endpoints from a canned checklist to inflate `surfaces_min`.

### 3.4 Opportunistic find rule (judgment-preserving)

If a **smoke-scale** request yields **strong** causal proof (e.g. obvious auth bypass on first login smoke):

- **Allowed:** capture proof in evidence/facts; if a legal Store path exists later, upsert as candidate.
- **Not required** for surface gate success.
- **Must not** convert the rest of the stage into a multi-class campaign; finish inventory intent first.
- Deep follow-up belongs in **`auth_session` / `class_probe`+** (and packages when multi-class).

This is **I4 light**: stage-scoped meaning of candidates (smoke/provisional vs probe campaign), without `candidates_min` on surface.

---

## 4. Option evaluation (I1–I5)

### I1 — Prompt-only

**Mechanism:** Strengthen `stage.success` + `stageSystemPrompt` / `stageUserPrompt` for surface (recon + bounded smoke) and class_probe (multi-class depth home). Align work.md / web-recon skill stop conditions.

| Pros | Cons |
|------|------|
| Matches harness-over-restriction and “agent interprets intent” | Soft; long act tool loops still allow deep grind |
| No new gates, quotas, or answer keys | Prompt/tool mismatch on `finding(upsert)` already confuses surface |
| Cheap to land in Spec #139 | Alone will not stop attention burn |

**Verdict:** **Required layer**, insufficient alone.

### I2 — Tool profile limits

**Mechanism:** Keep (and treat as intentional) surface: act yes, **`subagent` no**, **`finding` no**. Probe stages: subagent yes. `validate_book`: finding only.

| Pros | Cons |
|------|------|
| Already shipped and tested (`hard-graph-mature.test.ts`) | Cannot encode “smoke vs deep” via tool **names** alone |
| Hard channel separation: no multi-class Join, no booking on surface | Further stripping shell/http would cripple recon |
| Fail-closed on structure (`surfaces_min`) without class lists | Over-restriction temptation (deny script, cap http) is a design smell |

**Verdict:** **Keep as hard channel boundary**; do not expand into request quotas or skill denylists.

### I3 — Quota-smelling heuristics

**Examples of what this would be (reject):**

- `surface` must deposit ≥K surfaces of kinds {API, auth, …}
- Fail surface if candidate count >0 or if shell count >N
- `class_probe` must open ≥M packages or ≥C classes
- Target-linked expected finding counts

| Pros | Cons |
|------|------|
| Looks measurable | Violates AGENTS.md / work.md ban on fixed lists & hard quotas |
| | Simulates ability with process theater |
| | Punishes honest thin targets and lucky smoke finds |
| | Discovery yield already carefully **soft** and probe-scoped — good pattern; hard quotas are the opposite |

**Verdict:** **Reject as primary.** Soft discovery-yield on probe stages stays; no new hard quotas.

### I4 — Stage-scoped candidates

**Mechanism:** Semantics + Product state:

- Surface may produce **0** Store candidates and still pass.
- If opportunistic candidates appear, tag `stage_id=surface` (Store already can carry stage_id) and treat as **smoke/provisional** continuity into later stages — **not** as completion of multi-class work.
- Class_probe+ owns multi-class **new** candidates / package Join.
- Handoff merge already accumulates candidates; do not wipe surface opportunistic finds.

| Pros | Cons |
|------|------|
| Matches real pentest (“found SQLi during recon, still finish map”) | Surface **currently lacks** a legal Store deposit path (`finding` denied) |
| No required candidate count | Over-engineering if we invent a second candidate type |
| Aligns host settlement stage_id filters | Must not add `candidates_min` on surface “to force smoke quality” |

**Verdict:** **Adopt lightly** — semantic + prompt + optional future deposit path; **no** surface `candidates_min`.

### I5 — Hybrid (recommended primary)

Combine:

1. **I1** — Explicit stage-intent language (surface = inventory + bounded smoke; class_probe+ = multi-class depth; opportunistic find OK).
2. **I2** — Existing tool profiles as **channel law** (document in Spec #139; fix prompt mismatch so surface is not told to `finding(upsert)`).
3. **I4 light** — Opportunistic candidates allowed when a path exists; never required; multi-class campaign deferred.
4. **Existing soft Feedback** — discovery yield on probe stages only; structure `surfaces_min`; no finding-count gates.
5. **Reject I3** — no class quotas, no module matrices, no target answer keys.

| Pros | Cons |
|------|------|
| Uses Product-state spine already built (Spec #125 / #116 / #111) | Still relies on agent judgment for smoke depth (by design) |
| Minimal new machinery; Spec-feedable | Prompt edits alone need lab confirmation (map #140) |
| Preserves lucky finds and thin targets | |

**Verdict: I5 is the primary design.**

---

## 5. Recommended design (feed Spec #139)

### 5.1 Stage intent table (product law)

| Stage | Intent | Structure gate | Soft process | Forbidden “fake intelligence” |
|-------|--------|----------------|--------------|-------------------------------|
| `init` | RoE/target only | summary | — | Live recon |
| **`surface`** | Live inventory + **bounded smoke**; deposit ledger | `surfaces_min ≥ 1` + summary | Optional ledger richness metrics **non-gating** | Module lists; candidates_min; multi-class packages; booking |
| `auth_session` | Session/auth characterization + auth-class depth | summary | discovery_yield if rich+empty | — |
| **`class_probe`** | Multi-class hypothesis probe; packages when recon justifies | summary | discovery_yield | Package quotas; micro-spawn; answer keys |
| `authz_logic` / `component` | Dual-actor / named-component depth | summary | discovery_yield | One-package-per-static-URL |
| `validate_book` | Confirm feedback_ok → platform ledger | summary | booking alignment signals | Invent-without-id |

### 5.2 Prompt / graph text (I1) — direction for Spec, not code here

Surface `success` should state something equivalent to (non-target-specific):

> Live attack surface inventory deposited to the surface ledger from recon; optional **bounded smoke** only to characterize observed surfaces. Do **not** run multi-class exploit campaigns here — that is `class_probe`+. Opportunistic single-shot proof may be noted; finish inventory breadth before stopping.

Class_probe remains multi-class / packages / no quotas (already good).

Stage system prompt: **stage-id-aware** short intent block (not a keyword intent detector on free text — the **structured stage id** is the source of truth).

Fix non-subagent user prompt: surface deposits via **`fact(op=surface)` only**; do not instruct `finding(upsert)` when `finding` is denied.

### 5.3 Tool profile (I2) — freeze semantics

Do **not** remove shell/http/session from surface (recon needs them).  
Do **not** add subagent/finding to surface.  
Document this as **intent channel law**, not an accident of JSON.

### 5.4 Host Feedback (already correct spine)

- Keep `surfaces_min` structure fail-closed.
- Keep discovery_yield soft-fail **probe-like only**.
- Never add surface `candidates_min` or class-count gates.
- Process metrics remain **no expected-finding counts**.

### 5.5 Optional later (out of research minimum)

If opportunistic Store deposit on surface is desired: allow **serial** `finding(upsert)` only (still no `confirm` until validate_book), or host path from evidence — product decision; **not** required for I5. Prefer Spec #139 to decide.

---

## 6. Product-state tests **without answer keys**

These assert **process contracts**, never “target X has N SQLi.”

### 6.1 Structure / profile (deterministic)

| ID | Assert |
|----|--------|
| T1 | Mature `surface.require.surfaces_min === 1`; no `candidates_min` on any product stage |
| T2 | `surface` tool allow: has shell/http; **lacks** `subagent` and `finding` |
| T3 | `class_probe` allow includes `subagent`; lacks `finding` |
| T4 | `validate_book` allow includes `finding`; lacks shell/subagent |
| T5 | `evaluateStageGate(surface, {surfaces:[]})` fails `surfaces_min`; with ≥1 host-ledger surface passes (even if candidates empty) |
| T6 | Host settlement ignores agent `result.json` poison file for surfaces_min (existing #125 tests) |

### 6.2 Prompt contracts (deterministic)

| ID | Assert |
|----|--------|
| T7 | Surface stage prompt/success mentions recon/inventory and **bounded smoke** / not multi-class campaign (after Spec land) |
| T8 | Stage prompts: **no** exact package counts; **no** DVWA/Juice answer-key names |
| T9 | Surface prompt does **not** instruct `finding(upsert)` while finding denied |
| T10 | class_probe prompt prefers packages when multi-class justified |

### 6.3 Process Feedback (deterministic, no target keys)

| ID | Assert |
|----|--------|
| T11 | `evaluateDiscoveryYield({stageId:'surface', surfacesN:10, newCandidatesN:0, deadendsN:0})` → **not** soft-fail |
| T12 | `evaluateDiscoveryYield({stageId:'class_probe', surfacesN:10, fanoutPackagesN:1, newCandidatesN:0, deadendsN:0})` → soft-fail |
| T13 | `metricFamilyKeys` / process metrics never include expected_vuln_count fields |
| T14 | Handoff merge: surface-stage candidates (if any) append; later stages inherit (continuity) |

### 6.4 Judgment-preserving negatives (must fail if someone “helps” with answer keys)

| ID | Assert |
|----|--------|
| T15 | No graph JSON / stage prompt contains fixed module checklists or “must find SQLi/XSS” |
| T16 | No gate requires `candidates.length ≥ K` on surface or class_probe product graphs |
| T17 | Package require remains plan_node_id + honesty — not `packages_n ≥ K` |

### 6.5 Behavioral lab (optional map follow-up; still no answer keys)

| Signal | Pass shape |
|--------|------------|
| Surface end | Ledger `total ≥ 1`; stage passed; wall time not dominated by single-class payload thrash (operator narrative, not hard SLA) |
| Class_probe | When ledger rich and multi-class map present: packages or serial multi-class act; discovery_yield not soft-fail empty monologue |
| Booking | Confirms only on validate_book with finding_id |

Do **not** score surface by class hit-rate against a lab walkthrough.

---

## 7. Mapping to existing bans / precedents

| Precedent | How I5 respects it |
|-----------|-------------------|
| Spec #125 host settlement | Gates stay on ledger/Store/packages |
| Spec #116 process quality | Soft yield; no package quotas; anti-micro-spawn stays in class_probe |
| Spec #111 metric families | Surface rate ≠ findings booked ≠ fanout |
| work.md discovery breadth | Surface ends on inventory honesty, not “enough vulns” |
| Intent & workflow selection | Stage **id** is structured intent; no free-text keyword mode invent |
| Harness over restriction | Prefer prompt + channel law over new validators |

---

## 8. Risks and non-goals

| Risk | Mitigation |
|------|------------|
| Agents still deep-grind on surface | I1 language + lab review; optional future turn-budget **telemetry** (not hard fail) |
| Opportunistic SQLi forgotten | Handoff + Store continuity; class_probe prompt “inherit priors” |
| Over-eager I2 (strip act tools) | Explicitly rejected |
| “Bounded smoke” becomes a hidden payload list | Definition is effort/stop-condition based, not payload catalog |
| Soft scenario resurrection | Out of scope; Soft retired |

**Non-goals:** kill-chain state machine; stage-named product seats; expected finding SLA; target profiles.

---

## 9. Recommendation summary

| Field | Value |
|-------|--------|
| **Primary option** | **I5 — hybrid** |
| **Composition** | I1 (stage-intent prompts) + I2 (existing tool-profile channel law) + I4 light (opportunistic, non-required, stage-scoped candidates) |
| **Rejected primary** | **I3** (quota-smelling heuristics / fixed class counts) |
| **Bounded smoke** | Short characterize-or-deadend per **observed** surface; inventory-first; no multi-class campaign |
| **Structure gate** | Keep `surfaces_min: 1`; never `candidates_min` on surface |
| **Depth home** | Multi-class exploit / packages → `class_probe`+ |
| **Next** | Spec #139 consumes this research; product code only after Spec lock |

---

## 10. Source index (absolute paths)

| Source | Path |
|--------|------|
| Mature graph | `experts/pentest/graphs/hard/app_assessment.json` |
| Thin graph | `experts/pentest/graphs/hard/app_assessment_thin.json` |
| Process quality | `experts/pentest/work.md` |
| Web recon skill | `experts/pentest/skills/pentest-web-recon/SKILL.md` |
| Task graph continuity | `docs/specs/task-graph.md` |
| Stage prompts / executor | `node4/src/runtime/hard-graph-stage-executor.ts` |
| Gate / handoff | `node4/src/runtime/hard-graph-runner.ts` |
| Host settlement | `node4/src/runtime/host-stage-settlement.ts` |
| Discovery yield | `node4/src/runtime/hard-graph-feedback.ts` |
| Surface ledger | `node4/src/stores/surface-ledger.ts` |
| Fact surface deposit | `node4/src/tools/fact.ts` |
| Graph definition types | `node4/src/runtime/hard-graph-definition.ts` |
| Lab evidence (DVWA) | `benchmarks/hard-vs-node5/runs/20260724T021339Z/dvwa/scorecard.md` |
