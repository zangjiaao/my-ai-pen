# Research: init prior → Finding Store design options (D2)

Facts + design evaluation only. **No product implementation.**  
Ticket: GitHub [#142](https://github.com/zangjiaao/my-ai-pen/issues/142). Part of map [#140](https://github.com/zangjiaao/my-ai-pen/issues/140); feeds Spec [#139](https://github.com/zangjiaao/my-ai-pen/issues/139).

## Question

How should Expert Graph **init (or graph-start)** load Scope-asset open findings into the **Finding Store** as **re-verify work** — so Main can schedule retest — **without** auto-booking and **without** treating priors as a skip list?

## Executive answer

**Primary recommendation: P4 hybrid (host-seed Store + prompt/case_context surface).**

| Layer | Owner | Role |
| --- | --- | --- |
| **Finding Store rows** (`prior: true`, status `open`, **no bookable proof**) | **Host** at **graph-start** (before stage 0 agent) | Product SoT for re-verify work; package anchors; honest counts |
| **Visibility** (`case_context` + stage handoff note) | Host inject into **Hard Graph stage prompts** (today free-path only) | Main schedules; priors are work, not “already done” |
| **Fresh proof → confirm** | Agent act + existing Store gates | Rediscovery book only after this-run proof |

**Reject pure P2 / pure P3 / pure P5** as product DoD for Expert Graph. **P1 alone** is the structural spine but incomplete without visibility. **P4 = P1 + prompt surface.**

Non-negotiables (already product law):

- Platform ledger / Case is long-term SoT; Finding Store is **run** SoT for Graph booking.
- Priors need **fresh** proof to book (rediscovery merge); historical ledger text is **not** a confirm passport.
- No answer keys, no expected vuln counts, no skip-list from “台账已有”.

---

## Primary-source inventory (as of this research)

### 1. `app_assessment` Hard Graph — init tools

File: `experts/pentest/graphs/hard/app_assessment.json`

```json
"id": "init",
"success": "Target and RoE understood; stage handoff ready (no live recon on this stage)",
"require": { "summary": true },
"tools": { "allow": ["todo", "read", "fact", "skill", "write"] }
```

- Init is **explicitly non-recon**.
- **No** `platform_list_vulnerabilities`, **no** `finding`, **no** `shell`/`http`.
- Agent **cannot** load ledger priors via citizen tools on this stage even if prompts demand it.

### 2. Finding Store — `prior` + `importPriors` (R1)

File: `node4/src/runtime/finding-store.ts`

- `FindingRecord.prior?: boolean`; counts expose `prior_n`.
- `importPriors([...])` upserts with `prior: true`, `source: "platform_prior"`, default status **`open`**.
- **Production call sites: none** — only unit test `process-quality.test.ts` (“Prior import R1”).
- Host settlement **skips** `prior` rows when projecting candidates (`host-stage-settlement.ts` `storeCandidatesToProjection`: `if (r.prior) continue`).

Implications:

- Prior rows are designed **not** to inflate discovery-candidate yield.
- Import without `proof_excerpt` keeps rows non-confirmable (`assertConfirmAllowed` requires `feedback_ok` + proof; L0 ok requires proof).
- **If** import copies ledger historical `proof_excerpt`, L0 can mark `feedback_ok` and Main `finding(confirm)` may fill proof from Store — **false re-verify / auto-book path**. Spec must **strip bookable proof on seed**.

### 3. `case_context` injection

| Path | Injects `formatCaseContextInjection`? |
| --- | --- |
| Free OMP / chat (`session-runner.ts`, `prompt.ts`) | **Yes** |
| Hard Graph stage prompts (`hard-graph-stage-executor.ts` `stageSystemPrompt` / `stageUserPrompt`) | **No** |

`case-context.ts` findings block text (when present):

- “Findings already on ledger (**re-verify open ones — do not skip**)”
- Prefer high/critical; fresh acts → `finding(confirm)` rediscovery; interleave untested surface.

Platform builder (`platform/backend/app/services/case_context.py`):

- Loads Case vulns **+** ledger vulns on **Case assets**.
- Note steers open priors as re-verify workstream.
- Attached on `task_assign` via `_attach_case_context_to_task_assign`.

So: envelope often **has** `findings_summary`, but Expert Graph stage agents **do not see it** today.

### 4. Platform citizen tools + mission

- Tools: `platform_list_vulnerabilities` et al. (`platform-citizen.ts`, `tools/platform.ts`).
- Mission: open priors = re-verify workstream; honest counts; reconcile with list before closing claims.
- Tool description: “Call at task start… not a skip list.”
- **Graph stage tool allowlists override pack tools** — citizen tools are irrelevant on init if not in `tools.allow`.

### 5. Pack / harness language

| Source | Language |
| --- | --- |
| `docs/specs/harness.md` Prior re-verify | `case_context.findings_summary` / `platform_list_vulnerabilities` → re-prove; not skip list |
| `docs/prd.md` 补扫再确认 | Same; interleave; high/critical first |
| `experts/pentest/work.md` | “With open priors, include **Prior re-verify**” on todo map; “**re-verify packages get explicit prior Store ids**”; discovery packages get path fingerprints only |
| Soft history | Soft plan had a dedicated `prior_reverify` stage — **retired** as product mode; do not resurrect Soft product path |

### 6. Graph continuity / confirm gates

- Run-wide Store: `ensureProcessQuality` at graph start (`hard-graph-task.ts`); stage children **share** parent `processQuality.findingStore`.
- Confirm on Expert Graph: `finding_id` required; invent-without-id forbidden (`tools/finding.ts`).
- Dig-deeper: structured `focus_finding_ids` / `focus_note` on `task_assign` (map #81) — not NLP.

### 7. Session evidence (ticket)

Task `4f499989` (cited): init used **todo + fact only**; **zero** `platform_list_vulnerabilities`; **no** Store `prior` rows.

Matches code: init cannot list vulns; nobody calls `importPriors`; Hard Graph never injects `case_context`. Prompt/citizen text alone is insufficient.

---

## Option sketches (P1–P5)

### P1 — Host-seed Finding Store

**Idea:** At graph-start (or first stage entry), host maps Scope-open ledger rows → `FindingStore.importPriors` (or equivalent).

| Pros | Cons |
| --- | --- |
| Deterministic product SoT; matches Store-first Spec #116 | Invisible if stages never show priors |
| Works with init tool allowlist (no agent call) | Must strip historical proof carefully |
| Enables “re-verify packages get explicit prior Store ids” | Scope/status filter design needed |
| Aligns with host settlement skipping `prior` in discovery yield | Over-seed if filter wrong (noise) |

**Best timing:** **graph-start** in `hard-graph-task` after `ensureProcessQuality`, **before** stage-0 session — not agent init turn.

### P2 — Agent-must-call

**Idea:** Force Main to call `platform_list_vulnerabilities` then upsert/import into Store.

| Pros | Cons |
| --- | --- |
| Matches free-path citizen mission text | Init **cannot** call platform tools today |
| No new host pipeline | Session evidence: agents skip |
| | Agent-mediated SoT is fragile; soft-fail if skipped |
| | Upsert-by-agent with historical proof risks auto-book |

**Verdict:** Reject as primary. Optional later-stage list for reconciliation only.

### P3 — Prompt-only

**Idea:** Rely on `case_context` / mission / work.md text; no Store seed.

| Pros | Cons |
| --- | --- |
| Already built for free path | Hard Graph stages **omit** injection today |
| Zero Store schema risk | Prompt is not booking SoT; no prior Store ids for packages |
| | Easy skip-list behavior (“already on ledger”) |
| | Honest counts / scheduling stay ad hoc |

**Verdict:** Necessary **visibility layer**, insufficient alone.

### P4 — Hybrid (host-seed + prompt surface)

**Idea:** P1 Store seed **and** inject priors into Hard Graph prompts (case_context block + short handoff note / Store prior snapshot). Agent still re-proves; host never auto-books.

| Pros | Cons |
| --- | --- |
| Store SoT + Main awareness | Two surfaces to keep consistent |
| Package re-verify ids work | Spec must define proof-strip + status filter once |
| Survives init tool thinness | Slightly more host code (still small) |
| Matches work.md discovery vs re-verify package split | |

**Verdict:** **Primary recommendation.**

### P5 — Defer to probe

**Idea:** No init seed; load priors only when class_probe / validate_book runs (or resurrect Soft `prior_reverify` stage).

| Pros | Cons |
| --- | --- |
| Less init work | Early surface stage can “skip known” without Store truth |
| | Late seed delays package planning |
| | Dedicated Soft stage is retired product mode |
| | Same failure mode as today if probe never lists |

**Verdict:** Reject as primary. Probe stages **consume** prior Store rows; they should not be the first load.

---

## Recommended design (P4 detail)

### When

1. **Host graph-start** (preferred single site): after `ensureProcessQuality(parentRuntime.lifecycle)`, before first `executeStage`.
2. Optional idempotent re-sync on stage entry only if `task_assign` mid-run refresh is later productized — default once per Graph run.

### What rows

Source priority (structured only — no free-text NLP invent):

1. `task.focusFindingIds` (dig-deeper / focused re-verify) → force-include those platform ids when resolvable.
2. `task.caseContext.findings_summary` (platform-attached board for Case + Case assets).
3. Optional Node `platformApi` list if envelope missing and Scope host known — **secondary**; prefer envelope SoT.

Filter:

- Prefer **open** re-verify candidates (management/status not fixed/closed; use platform status fields already on summary rows).
- Scope: host/asset intersection with task Scope / Case assets — **not** whole-user ledger dump.
- Cap (e.g. same order as case_context ~20–25) with high/critical preference if over cap — **not** answer-key counts for gates.

### How rows look in Store

```text
prior: true
status: open
platform_vuln_id: <ledger id>
title / location / severity / class_key?: from ledger
source: platform_prior
proof_excerpt: ABSENT (strip even if case_context had historical proof)
poc: ABSENT or non-authoritative notes only
```

Do **not** `enqueueFeedback` / `applyMechanicalL0Feedback` on seed.

After seed, Main may:

- `finding(list)` / Store-aware tooling → see prior ids.
- Schedule **re-verify packages** with those Store ids (work.md).
- Act → upsert merge with **this-run** `proof_excerpt` → L0 → `finding(confirm, finding_id=…)` → platform rediscovery.

### Confirm / proof rules (spec-facing)

- Historical ledger proof in prompts is **orientation only**.
- Confirm on a `prior` row must require **this-run** grounded proof (observation/tool excerpt), not pre-seeded `proof_excerpt`.
- Today confirm may copy Store `proof_excerpt` into params — Spec #139 must close that hole for `prior: true` rows (e.g. reject confirm if only `source=platform_prior` proof, or require proof not equal to seed).

### Visibility (Hard Graph)

Inject into stage system/user prompts (init and later):

- Existing `formatCaseContextInjection(task.caseContext)` **or** a thinner “Store priors (re-verify)” snapshot from `findingStore.snapshot().filter(r => r.prior)`.
- Keep lean: do not triple-stack essays (harness lean-prompt rule). Citizen short rules + one findings list is enough.

### Auto-booking

- Seed **never** calls `markBooked` / `vuln_found`.
- Host settlement continues to **exclude** pure prior rows from discovery candidate projections.
- Honest counts: 重新验证 N = successful confirms this session, not `prior_n`.

---

## Answers to ticket decision questions

### L2 todos?

| Approach | Recommendation |
| --- | --- |
| Auto N L2 rows (one per prior) at init | **No** — process-chore / answer-key smell; init is non-recon |
| Auto single aggregate L2 “Prior re-verify (open priors)” under a later act stage | **Optional host assist** — not a structure gate |
| Agent creates “Prior re-verify” on todo map when open priors exist | **Yes** — already `work.md`; prefer after surface/recon when packages are planned |

L2 remains attack-class / coverage map. Priors live in **Store**; todos point at re-verify **workstream**, not a second SoT.

### Re-verify package marking?

**Yes.** Re-verify packages must carry explicit prior **Store** ids (work.md). Discovery packages get path fingerprints only — do not dump full prior bodies into discovery workers. Marking is for Main/worker prompt shaping and honesty, not a separate booking channel.

### Multi-conversation same asset?

- Platform case_context already includes ledger findings on **Case assets** (cross-conversation identity on asset).
- Host seed should use **Scope/Case asset intersection**, not “all user vulns”.
- Same asset, new Case: open ledger rows seed as `prior` for re-verify (rediscovery product path).
- Same Graph run: seed once; merge by L0 path/class rules if agent rediscovers; do not double-count `prior_n` on re-import (idempotent by `platform_vuln_id` or path+class).

### Init `require` field?

**No new agent-facing require for prior load.**

- Init stays `require.summary` (understand target/RoE); no live recon.
- Host seed is **precondition host work**, not a stage gate on agent tools.
- Do not block init on re-verify completion.
- Do not force platform tools onto init allowlist solely for this (host seed removes need); later stages may keep list tools for reconciliation if product allows.

---

## Rejects (short)

| Id | Why reject as primary |
| --- | --- |
| **P2** | Init tool allowlist + observed non-call; agent is wrong SoT owner |
| **P3** | No Store ids for re-verify packages; Hard Graph currently does not inject; skip-list risk |
| **P5** | Late/optional load; Soft `prior_reverify` retired; fails early scheduling |
| **P1 alone** | Structurally right but Main may never see rows without prompt surface → prefer P4 |

---

## Implementation sketch (for Spec #139 — not this ticket)

Out of research scope, but keep design coherent:

1. `hard-graph-task` after `ensureProcessQuality`: `seedPriorsFromTask(task, findingStore)`.
2. Map `case_context.findings_summary` + `focus_finding_ids` → `importPriors` with **proof stripped**.
3. Inject `formatCaseContextInjection` (or Store prior snapshot) into `stageSystemPrompt` / `stageUserPrompt`.
4. Confirm gate: `prior` rows require this-run proof (tighten `assertConfirmAllowed` / confirm path).
5. Tests: seed creates `prior_n`; settlement candidates exclude pure priors; confirm without fresh proof fails; package can reference prior Store id.
6. Docs: `harness.md` Prior re-verify + `task-graph.md` Finding Store + `work.md` one line if needed.

**No product code in this research ticket.**

---

## Traceability

| Concern | Source of truth after P4 |
| --- | --- |
| Long-term vuln identity | Platform ledger |
| This-run re-verify work list | Finding Store `prior: true` rows |
| Main schedule / package shape | LLM judgment + Store ids + work.md |
| Bookable proof | This-run tool proof only |
| Discovery yield metrics | Non-prior Store rows (existing host settlement) |

---

## Bottom line

**Option id: P4 (hybrid).**  
Host-seed open Scope/Case findings into Finding Store at **graph-start** as `prior` open rows **without bookable proof**; surface them in Hard Graph prompts via case_context/Store snapshot so Main can schedule re-verify packages; never auto-book; never treat ledger presence as skip.
