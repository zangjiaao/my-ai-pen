# Research: Severity integrity design options (D1)

Ticket: GitHub **#141** · Map **#140** · feeds Spec **#139**  
Scope: Product state assign / preserve / fail-closed severity for Expert Graph bookings — **no answer keys**, **no fake intelligence**, Graph × Pi / Node4 only.  
Status: **research only** (no product code changes in this note).

---

## Executive answer

**Primary recommendation: S4 hybrid — agent-assigned severity + Store-first preserve + fail-closed omit (S1 as the hard core), with light harness steer (tool/work text), not host scoring.**

| Concern | Decision |
| --- | --- |
| **Who assigns** | The **Agent (LLM judgment)** at candidate / upsert / confirm time — same class of judgment as title, claim, and impact narrative. Not platform keyword maps. |
| **Who preserves** | **Finding Store** (`FindingRecord.severity`) through package settlement → L0 → confirm → `vuln_found` → platform ledger. Confirm must **fill severity from Store** like title/proof, not only from tool args. |
| **Fail-closed** | **No silent `"medium"` default** on Node confirm or platform ingest when severity is missing/invalid. Missing/invalid → reject booking (or refuse ledger write) until an allowed enum is present. |
| **Not product truth** | Chat prose; host CWE/class→severity tables; CVSS-lite host calculators; expected severity histograms / DVWA answer keys. |

**Reject S2** (host impact→severity maps), **S3 alone** (prompt-only), and **S5** (CVSS-lite) for reasons below. **S1 alone** is necessary but incomplete without preserve + candidate plumbing.

---

## Problem statement (session + code)

### Observed collapse

Session evidence already known (DVWA Expert Graph booking run):

| Surface | Severity distribution |
| --- | --- |
| Finding Store | **22/22 medium** |
| Platform ledger | **13/13 medium** |
| Tool calls | Most `finding` confirms **omitted** `severity` |

All-medium is **not** proof the agent judged every issue medium. It is consistent with **optional severity + silent default**.

### Booking path (product SOT)

Product truth is **Finding Store + confirm → platform ledger**, not chat (`CONTEXT.md` Product state SOT; `docs/specs/harness.md` “Chat is not product truth”; `docs/specs/task-graph.md` Finding Store row).

```text
Sub package candidates[] ──ingest──► Finding Store (upsert + L0 Feedback)
Main finding(upsert)     ──ingest──► Finding Store
Main finding(confirm, finding_id) ──assert feedback_ok──► findings/*.json + platform vuln_found
```

Severity must be correct on **that** chain. Improving chat wording alone cannot fix ledger collapse.

---

## Evidence from primary sources

### 1. Confirm defaults omitted severity to medium

`node4/src/tools/finding.ts` — both proof path and legacy path:

```510:510:node4/src/tools/finding.ts
          severity: String(params.severity || "medium"),
```

```614:614:node4/src/tools/finding.ts
        severity: String(params.severity || "medium"),
```

`severity` is optional on the tool schema (`Type.Optional`). When the model omits it, the record and `vuln_found` still go out as `"medium"`.

### 2. Graph Store gate fills title/location/proof/poc — not severity

On Expert Graph confirm, after `assertConfirmAllowed`:

```331:343:node4/src/tools/finding.ts
        if (!String(params.title || "").trim()) params.title = gate.record.title;
        if (!String(params.location || params.url || "").trim()) {
          params.location = gate.record.location;
        }
        if (!String(params.description || "").trim() && gate.record.description) {
          params.description = gate.record.description;
        }
        if (!String(params.proof || "").trim() && gate.record.proof_excerpt) {
          params.proof = gate.record.proof_excerpt;
        }
        if (!String(params.poc || "").trim() && gate.record.poc) {
          params.poc = gate.record.poc;
        }
```

**No** `params.severity = gate.record.severity`. Even if Store had a non-medium value, confirm would ignore it and still default to medium when the arg is omitted.

### 3. Package candidate contract has no severity field

`node4/src/runtime/subagent-result.ts` — `SubagentCandidate`:

```6:12:node4/src/runtime/subagent-result.ts
export type SubagentCandidate = {
  title?: string;
  location?: string;
  claim?: string;
  proof_excerpt?: string;
  poc_hint?: string;
};
```

`asCandidates` never reads `severity` / `impact` / `cvss`. Workers **cannot** land severity on structured settlement even if they invent a field in JSON today (it is dropped).

### 4. Package settlement → Store drops severity

`ingestPackageCandidatesToStore` in `node4/src/runtime/finding-store.ts`:

```403:414:node4/src/runtime/finding-store.ts
      const up = store.upsert({
        title: c.title || "candidate",
        location: c.location || meta.fallback_location || "unknown",
        description: c.claim,
        proof_excerpt: c.proof_excerpt,
        poc: c.poc_hint,
        package_id: meta.package_id,
        plan_node_id: meta.plan_node_id,
        stage_id: meta.stage_id,
        agent_id: meta.agent_id,
        source: meta.package_id,
      });
```

Call site: `node4/src/tools/subagent.ts` (~850–859) after package honesty terminal — same ingest helper. **Severity never enters Store from packages.**

Main serial `finding(upsert)` uses the same ingest helper and also **does not pass** `params.severity` into candidates.

### 5. Store *can* hold severity but L0 ignores it

`FindingRecord.severity?: string` and `upsert` set `severity: input.severity` / merge `input.severity ?? cur.severity`.  
L0 mechanical Feedback (`applyMechanicalL0Feedback`) only checks **`proof_excerpt` present** → `feedback_ok`. Severity is not a gate and is usually `undefined` on package rows.

### 6. Tool description never mentions severity

`FINDING_TOOL_DESCRIPTION` in `node4/src/runtime/booking-harness.ts` lists confirm requirements (title, location, description, poc, proof) — **no severity / impact band**. Models optimize for listed required fields; optional unlisted fields are omitted.

### 7. Platform double-defaults to medium

`platform/backend/app/ws/router.py`:

```149:151:platform/backend/app/ws/router.py
def _normalize_severity(value: object) -> str:
    severity = str(value or "medium").strip().lower()
    return severity if severity in {"critical", "high", "medium", "low", "info"} else "medium"
```

Used on `vuln_found` (~2186). Empty **or invalid** → medium. Frontend `normalizeFindingSeverity` (`platform/frontend/src/lib/findingKinds.ts`) similarly maps empty → medium for badges.

So even a Node that omitted the field (or sent garbage) would present as medium end-to-end.

### 8. Expert pack: impact proof bar, not severity assignment

`experts/pentest/work.md` unified proof bar requires **Causality · Reproducibility · Impact** before confirm. Impact is a **booking eligibility** bar (demonstrable harm), not a mapped enum. Skills reiterate “book only with demonstrable impact” without an enum protocol for `critical|high|medium|low|info`.

UI design language (`docs/design.md`) documents human-readable examples (RCE→critical, SQLi→high, XSS→medium) for **chrome colors** — not an approved host scoring engine and not to be hard-coded as product intelligence without approval (`AGENTS.md` No Hardcoded Behavior / Harness Over Restriction).

### 9. Product SOT language

| Source | Relevant claim |
| --- | --- |
| `CONTEXT.md` | Product state SOT includes findings/booking; transcript not domain authority |
| ADR 0001 | Product state is SOT; gates must not parse private Runtime formats as truth |
| `docs/specs/harness.md` | Booking via structured tools only; chat not product truth |
| `docs/specs/task-graph.md` | Store-first; confirm ⇒ `vuln_found`; agent files not booking channel |

Severity on the **ledger** is product state. Silent medium is a **Product-state integrity** bug, not a “model preference.”

---

## Option sketches (S1–S5)

| Id | Sketch | Assign | Preserve | Fail-closed | Fits constraints? |
| --- | --- | --- | --- | --- | --- |
| **S1** | Fail-closed omit | Agent must supply enum | Partial (unless Store fill added) | **Yes** — reject missing/invalid | Yes for gate; incomplete alone |
| **S2** | Host impact→severity | Host derives from text/class | Yes once derived | Yes | **No** — host fake intelligence / class maps |
| **S3** | Prompt-only | Hope model fills optional field | No code preserve | **No** — defaults remain | Insufficient |
| **S4** | Hybrid (S1 + preserve + steer) | Agent | Store + confirm + platform | S1 core | **Yes** |
| **S5** | CVSS-lite | Agent metrics or host formula | Schema-heavy | Optional | Over-spec; fake precision risk |

### S1 — Fail-closed omit

**Idea:** Treat severity like proof: allowed set `{critical, high, medium, low, info}`; missing or invalid → confirm error; remove `|| "medium"`.

**Pros**

- Aligns with existing fail-closed booking gates (proof length, ground check, `feedback_ok`).
- No answer keys; medium remains valid when **explicitly** chosen.
- Smallest mechanical fix at the product boundary users see.

**Cons alone**

- Without Store fill + candidate field, Main must re-invent severity every confirm (thrash risk, same class as invent-without-id).
- Without tool/work steer, models may thrash on new required field until description updates.
- Platform still medium-defaults if any other producer sends empty.

### S2 — Host impact→severity

**Idea:** Host maps description/title/CWE/class_key/proof keywords → severity (or design.md-style class table in code).

**Reject**

- Violates **No Hardcoded Behavior Without Approval** and **Harness Over Restriction** (class→severity is simulated expertise).
- Parallel to forbidden “expected vulnerability counts / fixed lists.”
- Wrong layer: severity is **judgment over demonstrated impact**, not a regex over title tokens (“SQL” in a low-impact error message ≠ high).
- `docs/design.md` palette examples are UI semantics, not a scoring API.

### S3 — Prompt-only

**Idea:** Thicken `work.md` / stage prompts / `FINDING_TOOL_DESCRIPTION` only.

**Reject as sole fix**

- Code path **already** invents medium when the field is omitted; better prompts cannot override `params.severity || "medium"`.
- Package normalize **drops** severity even if the child writes it.
- Observed session: omission is the dominant pattern — optional + silent default will keep collapsing.

Prompt/work updates remain a **necessary accessory** under S4, not a standalone design.

### S4 — Hybrid (recommended)

**Idea:** Compose:

1. **S1 fail-closed** at confirm (and platform refuse empty/invalid from Node bookings).
2. **Assign:** agent supplies severity on candidates / upsert / confirm (judgment tied to demonstrated impact triad in `work.md`).
3. **Preserve:** candidate → `ingestPackageCandidatesToStore` → `FindingRecord.severity` → confirm fills from Store → `vuln_found` carries explicit enum; merge prefers explicit higher only when both sides have real values (repair script already ranks severities).
4. **Steer (harness, not restriction):** tool description requires severity; pack work text maps impact narrative → enum **as agent guidance** (not code tables of module names).
5. **No** host CWE map, **no** CVSS required, **no** expected distribution gates.

### S5 — CVSS-lite

**Idea:** Structured vector (AV/AC/PR/UI/S/C/I/A subset) → host-computed base score → band.

**Reject for D1 / Spec #139 near-term**

- Schema weight on every candidate vs product value of five-band severity already in UI (`docs/design.md`).
- If host computes from free text, same fake-intelligence problem as S2; if agent fills full vector, higher token cost and thrash without fixing omit→default first.
- Can revisit later as **optional enrichment** after S4 integrity, not as the integrity mechanism.

---

## Recommended primary design (S4 detail)

### A. Allowed values (contract)

Canonical enum (already shared by platform + UI):

`critical | high | medium | low | info`

Normalize case only. **Invalid → reject**, never coerce to medium.

### B. Assign (agent judgment)

| Actor | Action |
| --- | --- |
| Package worker | Include `severity` on each `candidates[]` row (structured settlement). |
| Main serial | `finding(upsert, …, severity=…)` when depositing without packages. |
| Main confirm | Pass `severity` **or** rely on Store-filled value after gate; must end with explicit enum before finalize. |

Judgment criterion (product language, not code map): align with **demonstrated impact** from the proof bar (`experts/pentest/work.md`) — e.g. code exec / full host compromise → critical; significant data/auth impact without full takeover → high; limited XSS/CSRF/info classes when impact is partial → medium; hardening / low exposure → low; observational → info. This stays in **prompts/skills**, not host classifiers.

### C. Preserve (Product state seams)

| Seam | Module / symbol | Change concept (Spec #139 — not implemented here) |
| --- | --- | --- |
| Candidate type | `SubagentCandidate` + `asCandidates` in `subagent-result.ts` | Accept optional `severity` string |
| Package → Store | `ingestPackageCandidatesToStore` | Pass `severity` into `store.upsert` |
| Serial upsert | `createFindingTool` action upsert | Pass `params.severity` into ingest candidate |
| Store | `FindingRecord` / `FindingUpsertInput` | Already has field; ensure merge does not invent medium |
| Confirm gate fill | `createFindingTool` graphStoreGate block | Fill `params.severity` from `gate.record.severity` when arg empty |
| Finalize | `finalizeFinding` | Require normalized severity; **remove** `\|\| "medium"` |
| Platform | `_normalize_severity` / `vuln_found` handler | Fail or leave unchanged on missing/invalid for Node bookings; do not invent medium |
| Tool copy | `FINDING_TOOL_DESCRIPTION` | List severity as required for confirm |
| Pack | `experts/pentest/work.md` | Short severity enum + impact alignment (agent guidance) |

### D. Fail-closed rules

1. **Confirm:** if after Store fill severity is empty or not in enum → `error:` (no file write, no `vuln_found`).
2. **Platform:** if severity missing/invalid on `vuln_found` → do not create/update with medium invented; surface error / drop with observability (prefer Node fail-closed so this is defensive).
3. **Explicit medium is allowed** — only silent default is banned.
4. **Do not** gate stage advance on severity diversity or “not all medium.”

### E. L0 Feedback scope

**Default recommendation:** keep L0 as **proof_excerpt mechanical** (Spec #116). Severity integrity is enforced at **confirm** (user-trustable conclusion), not by expanding L0 into judgment.

Optional later: soft warn on `finding(list)` / acceptance assist when `feedback_ok` rows lack severity — assistive, not stage fail.

### F. Priors / rediscovery

`importPriors` already accepts `severity?`. Preserve platform prior severity into Store; on rediscover merge, prefer explicit non-empty severity and existing platform rank logic in repair (`repair_finding_ledger.py` higher-severity preference) — still no invent-on-empty.

---

## Explicit rejects (summary)

| Option | Reject reason (grounded) |
| --- | --- |
| **S2 host impact→severity** | Host maps = hardcoded intelligence; conflicts with AGENTS harness-over-restriction and intent rules; impact is agent judgment over proof, not keyword tables. |
| **S3 prompt-only** | `severity \|\| "medium"` + platform `_normalize_severity` + dropped candidate field make collapse structural; prompts cannot override code defaults. |
| **S5 CVSS-lite** | Heavy schema; either host-fake-score or agent thrash; not needed for five-band ledger integrity after S4. |
| **S1 alone** | Necessary gate but missing preserve (Store fill, package field, ingest) → re-entry thrash and empty Store forever. |
| **Answer-key / histogram gates** | “Must not be all medium” or DVWA expected bands = forbidden expected-finding simulation. |

---

## Product-state tests (no DVWA answer keys)

Contract tests only — fixtures invent **synthetic** titles/locations/proofs; never assert real lab module lists or expected counts.

| # | Test intent | Assert |
| --- | --- | --- |
| T1 | Confirm omit severity, no Store severity | Error; no `findings/*.json`; no `vuln_found` |
| T2 | Confirm invalid severity (`"urgent"`) | Error; not coerced to medium |
| T3 | Confirm explicit `medium` | Success; record + event severity `medium` |
| T4 | Store `high`, confirm omits severity | After fill: booked as `high` (not medium) |
| T5 | Package candidate `severity: critical` → ingest → Store | Snapshot row severity `critical` |
| T6 | Package candidate without severity → confirm without | Fail closed (T1 path) |
| T7 | Upsert with severity `low` → feedback_ok → confirm with finding_id only | Ledger `low` |
| T8 | Platform normalize empty | Does not write medium (or rejects) when Node would have been fixed |
| T9 | Merge: existing Store severity kept when re-upsert omits severity | `input.severity ?? cur.severity` behavior preserved |
| T10 | L0 still ok without severity if proof present | Stage Feedback not blocked by severity (unless Spec later tightens) |

**Out of scope for integrity gates:** severity histogram diversity, “RCE must be critical,” Juice/DVWA class coverage.

Suggested homes: `node4/src/tools/finding*.test.ts` / existing process-quality store-first e2e style (`process-quality-store-first-e2e.test.ts`) with explicit severity cases; platform unit around `_normalize_severity` behavior once Spec #139 freezes the fail-closed contract.

---

## Conceptual module map (for Spec #139)

```text
                    ┌─────────────────────────────┐
  worker JSON       │ SubagentCandidate.severity  │  subagent-result.ts
                    └─────────────┬───────────────┘
                                  │ ingestPackageCandidatesToStore
                                  ▼
                    ┌─────────────────────────────┐
                    │ FindingStore.upsert         │  finding-store.ts
                    │ FindingRecord.severity      │
                    │ L0: proof only (unchanged)  │
                    └─────────────┬───────────────┘
                                  │ assertConfirmAllowed + fill
                                  ▼
                    ┌─────────────────────────────┐
                    │ finding(confirm)            │  finding.ts
                    │ normalizeSeverity() fail-closed
                    │ finalizeFinding → file + WS │
                    └─────────────┬───────────────┘
                                  │ type: vuln_found
                                  ▼
                    ┌─────────────────────────────┐
                    │ platform _normalize_severity│  ws/router.py
                    │ ledger Vulnerability.severity│
                    └─────────────────────────────┘
```

Harness steer (non-gate): `booking-harness.ts` tool description; `experts/pentest/work.md` impact↔enum guidance.

---

## Relation to map #140 / Spec #139

| Artifact | Role |
| --- | --- |
| This research (D1 / #141) | Choose integrity design; seams + tests |
| Spec #139 | Normative: enum, fail-closed, Store preserve, candidate field, platform contract |
| Implementation | Separate ticket after Spec; **not** this research |

---

## Sources (repo)

| Path | Symbols / notes |
| --- | --- |
| `node4/src/tools/finding.ts` | `createFindingTool`, `finalizeFinding`, `severity \|\| "medium"`, Store fill block |
| `node4/src/runtime/finding-store.ts` | `FindingRecord`, `upsert`, `applyMechanicalL0Feedback`, `ingestPackageCandidatesToStore` |
| `node4/src/runtime/subagent-result.ts` | `SubagentCandidate`, `asCandidates` |
| `node4/src/tools/subagent.ts` | package settlement → `ingestPackageCandidatesToStore` |
| `node4/src/runtime/booking-harness.ts` | `FINDING_TOOL_DESCRIPTION` |
| `platform/backend/app/ws/router.py` | `_normalize_severity`, `vuln_found` handler |
| `platform/frontend/src/lib/findingKinds.ts` | `normalizeFindingSeverity` |
| `experts/pentest/work.md` | Unified proof bar (impact) |
| `docs/specs/harness.md`, `docs/specs/task-graph.md` | Booking / Store rules |
| `CONTEXT.md`, ADR 0001 | Product state SOT |
| `docs/design.md` | UI severity palette (not host scorer) |

Session observation (not a code path): DVWA Expert Graph run Store 22/22 medium, platform 13/13 medium; most confirms omitted severity — consistent with structural default, not universal medium judgment.

---

## Resolution one-liner

**Recommend S4 hybrid (agent assign + Store preserve + S1 fail-closed omit; light tool/work steer). Reject S2 host maps, S3 prompt-only, S5 CVSS-lite, and answer-key histogram gates.**
