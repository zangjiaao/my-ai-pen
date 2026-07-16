# Evidence quality plan (Case collaboration prerequisite)

> **Status:** living tracker  
> **Precedence:** `AGENTS.md` → `prd.md` → this plan (evidence) / `multi-expert-collaboration-plan.md` (Case collab)  
> **Why:** Multi-expert Case collaboration assumes **shared findings/evidence** of usable quality. Without durable proof on the Case, `case_context` and “next expert continues” fail.  
> **Non-goals:** Case shared-disk product; structured handoff protocol; stations.

**Related:** `node4-harness.md` (proof-first booking), `node-expert-offers.md` (Case = session), `benchmarks/collab-playbook-b/` (manual collab lab).

---

## Progress

| Phase | Goal | Status | Notes |
|-------|------|--------|-------|
| **A** | Baseline audit from real samples | **Done** (2026-07-16) | Local workspace + collab runs + `pentest_platform` DB |
| **B0** | Fix Case evidence “empty shell” (properties) | Pending | P0 — blocks all Case reuse |
| **B1** | Denoise: what counts as Case evidence | Pending | Drop non-proof tools; prefer finding-linked |
| **B2** | Collaboration readability (`case_context` + excerpts) | Pending | Next expert can act from Case |
| **B3** | Proof semantics (1:1 claim support) | Pending | Tighten multi-finding reuse |
| **B4** | Re-verify (Playbook B / real Case) | Pending | Success criteria below |

Update this table when a phase completes (date + short note / commit).

---

## Collaboration model reminder (minimal)

```text
Case = Session
  ├── chat + findings + evidence  (shared truth)
  ├── case_context on task_assign (trimmed read for joining expert)
  └── user @ / select expert

Not required: structured handoff API, Case shared disk, stations
Materials (source dumps, notes) → book as evidence or clear chat paths
```

---

## Phase A — Baseline audit (completed 2026-07-16)

### A.1 Samples inspected

| Source | Scale | Nature |
|--------|-------|--------|
| `node4/workspace/c6efe561-ba5e-43a5-a15b-3eb674c72190` | 73 evidence / 17 findings | Live pentest (DVWA / Juice / platform API) |
| `node4/workspace/f56f5061-b531-4b2e-9073-13052e55623d` | 42 evidence / 20 findings | Live pentest (DVWA) |
| `node4/workspace/95ebf2f6-9ba0-4894-9f91-6dc501cdafeb` | 32 evidence / 14 findings | Mixed http/session/script |
| `benchmarks/collab-playbook-b/run/station*-ws*` | 14–31 evidence / 3–10 findings | Collab dry-run (static + verify) |
| Platform DB `pentest_platform` | **385** evidence / **73** vulns | Two main `conversation_id`s; via `platform-db-1` |

### A.2 Architecture (as implemented)

| Layer | Storage | Lifetime |
|-------|---------|----------|
| Node task | `workspace/<taskId>/evidence/*.json` | Per burst only; `finding(confirm)` validates **here** |
| Platform Case | DB `evidence` (`conversation_id`, `properties` JSONB) | Session-scoped; filled by WS `evidence_created` |

Flow:

```text
shell/http/session/… → emitEvidence → local JSON + evidence_created → platform
finding(confirm) → require local evidence_ids + demonstrable output → vuln_found
```

**Gap:** Next expert’s new `taskDir` cannot read prior local files; Case DB is the intended share — but properties content is currently unusable (see A.4).

### A.3 Local Node quality (within one task)

**Strengths**

- Node4 `finding(confirm)` gates: required `evidence_ids`, location, description, PoC structure, **demonstrable** stdout/body/redirect (`node4/src/tools/finding.ts`).
- Sampled findings: **100% had evidence_ids**; local files resolved (no missing eid files in sampled tasks).
- Good proof examples: login 200/401 with body; session HTTP captures; collab static findings with `proof_excerpts` from `cat` of source.

**Weaknesses (local)**

| Issue | Example |
|-------|---------|
| **Orphan evidence** | c6efe ~55/73 unused by any finding; f56f ~29/42; collab s3-v2 ~27/31 |
| **One evidence → many unrelated findings** | f56f `ev_*9679fd` linked to upload RCE + stored XSS + reflected XSS + CSRF; another eid to blind SQLi + DOM XSS + weak session |
| **Noise** | `ls` / `total N`, empty stdout, session chain with no body |
| **Gate only checks “has output”** | Not that the excerpt supports **this** finding’s claim |
| **No first-class file artifact type** | Source dumps via shell `cat` only; `write` does not emit evidence |

### A.4 Platform Case quality (shared layer) — critical

| Metric (2026-07-16 snapshot) | Result |
|------------------------------|--------|
| evidence rows | 385 |
| type `tool_output` / `evidence_created` | 240 / 145 |
| `raw_ref` empty | **385 / 385** |
| properties contain `stdout` | **0** |
| properties contain HTTP body keys | **0** |
| empty-ish properties (`status`/`stderr` only etc.) | **~354 / 385** |
| “rich” properties (len > 100) | **~14** |
| `source_tool` includes non-proof tools | finding, todo, skill, read (~89 rows) |

**Smoking gun (same `evidence_id`):**

| | Local Node JSON | Platform DB |
|--|-----------------|-------------|
| `ev_1784055584931_9679fd` | `data.stdout` ~1603 chars (real script output) | `properties = {"status": null, "stderr": ""}` |
| summary | Useful command prefix | Command prefix only; **no proof payload** |

So: **IDs sync; proof content is lost or never stored** on the Case.  
Even if the next expert could fetch by id, they would not get demonstrable proof.

**Pollution examples**

- Summaries that are entire `{"ok": true, "finding": {...}}` tool results stored as evidence.
- Dual/noisy rows: tool return dumps vs intended `evidence_created`.
- Session rows with empty body but still listed as evidence.

**Implication for collab:**  
“Evidence is shared on the Case” is **not true in product terms** today — only **empty shells** are shared.

### A.5 Code pointers (for implementers)

| Area | Path |
|------|------|
| Local store | `node4/src/stores/evidence.ts` |
| Emit to platform | `node4/src/tools/common.ts` → `emitEvidence` / `evidencePropertiesForPlatform` |
| Finding gates | `node4/src/tools/finding.ts` → `extractProofMaterial`, `pocDemonstratesIssue` |
| Booking nudges | `node4/src/runtime/booking-harness.ts` |
| Platform persist | `platform/backend/app/ws/router.py` → `_persist_evidence`, `_proof_properties_from_summary` |
| Platform model/API | `platform/backend/app/models/evidence.py`, `api/evidence.py` |
| Case context (hints only today) | `platform/backend/app/services/case_context.py` — `evidence:id` tokens, **no body** |
| Node inject | `node4/src/runtime/case-context.ts` |

### A.6 One-line Phase A conclusion

**Local booking discipline is OK; Case-layer evidence is hollow; multi-expert continuation on Case evidence is not viable until B0–B2 land.**

---

## Phase B0 — Fix Case evidence empty shell (P0)

**Goal:** Platform `evidence.properties` retain usable proof fields (truncated OK, empty not OK).

**Work**

1. Trace one `evidence_created` end-to-end: Node outbound payload → WS handler → `_persist_evidence` → DB row.
2. Fix loss of `stdout` / `body_preview` / `response_body` / `command` / `url` / `status` / `proof` (and HTTP equivalents from `evidencePropertiesForPlatform`).
3. Ensure updates merge without wiping rich properties with empty `{status, stderr}`.
4. Add a regression test: persist sample shell/http evidence → DB has non-empty proof keys (or body excerpt).

**Done when**

- For a new run, `GET /api/evidence/{id}` (or SQL) shows the same essential proof as local `evidence/*.json` (clipped).
- Spot-check ≥5 new ids after a short pentest: 0 with only `{status, stderr}`.

**Out of scope for B0:** UI redesign; shared disk; finding gate changes.

---

## Phase B1 — Denoise: what counts as Case evidence

**Goal:** Case evidence list is mostly **proof**, not tool telemetry spam.

**Work**

1. Only promote **`evidence_created`** from act tools (`shell`, `http`, `session`, `script`, `browser`, …) into the Case evidence product surface.
2. Stop treating **finding / todo / skill / read** tool results as evidence rows (or hard-exclude them).
3. Prefer **`case_context` / UI default** to evidence **referenced by findings** (orphans optional “trace” later).
4. Optional: mark local orphans as `trace` vs `proof` if a field is added; do not invent NLP.

**Done when**

- New Case after a session: majority of evidence rows are finding-linked **or** clearly act-tool proofs with non-empty properties.
- finding/todo JSON summaries no longer appear as evidence titles.

---

## Phase B2 — Collaboration readability

**Goal:** Joining expert can continue from Case without private taskDir paths.

**Work**

1. Extend `case_context` (after B0) with:
   - findings board including `evidence_ids`
   - short excerpts for **referenced** evidence (from DB properties)
   - path/url hints when present
2. Still cap tokens; do not dump full transcripts.
3. Optional: Node tool or assign payload to resolve `evidence_id` → Case snippet (if assign payload alone is insufficient).

**Done when**

- Playbook B station 3 (or equivalent) can work primarily from `case_context` + Case findings/evidence, without manually copying absolute paths / HANDOFF files.
- Second expert does not need prior `taskDir`.

**Depends on:** B0 (otherwise excerpts stay empty).

---

## Phase B3 — Proof semantics

**Goal:** Evidence supports **this** claim, not “any long stdout”.

**Work**

1. Tighten multi-finding reuse: same `evidence_id` on multiple findings only if each has a distinct supporting excerpt / or require separate proof when claims differ.
2. Align booking status with reality (e.g. dynamic blocked vs static confirmed) — no silent overclaim.
3. Consider optional `file_artifact` / `source_excerpt` type for static packs (still not a Case disk product).
4. Use `raw_ref` when there is a durable path/object key (optional).

**Done when**

- Sampled multi-link eids no longer attach unrelated vuln classes to one blob without justification.
- Static vs dynamic booking language is consistent in findings.

---

## Phase B4 — Re-verification

**Goal:** Prove the stack works for multi-expert Case collaboration.

**Work**

1. Re-run `benchmarks/collab-playbook-b` (code-audit → pentest) with **platform path** if possible (not only standalone).
2. Re-sample platform DB metrics (A.4 table).
3. Record results in this doc (date + pass/fail).

**Success criteria**

| Check | Pass |
|-------|------|
| New evidence properties non-empty for act tools | Y/N |
| Orphan / pollution rate down vs Phase A | Y/N |
| `case_context` includes usable excerpts for booked findings | Y/N |
| Next expert continues without private path copy | Y/N |
| No ambient lab drift when scope is tight (collab B) | Y/N |

---

## Explicit non-goals (keep out of this track)

- Case shared filesystem / shared disk product  
- Structured handoff API as collaboration backbone  
- Stations UI  
- Weakening finding gates to increase booking count  
- Dumping all shell evidence into LLM context without filter  

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-16 | Phase A completed; B0–B4 planned; doc created from workspace + `pentest_platform` sampling |
