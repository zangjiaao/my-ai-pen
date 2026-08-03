# Spec: Base booking + unified finding_id

**Status:** implemented (Wave 1)  
**Issue:** [#279](https://github.com/zangjiaao/my-ai-pen/issues/279)  
**Related:** [#275](https://github.com/zangjiaao/my-ai-pen/issues/275) identity/New; Product state → UI projection Spec ([#280](https://github.com/zangjiaao/my-ai-pen/issues/280), `docs/specs/product-state-ui-projection.md`); #274 hypothesis (orthogonal); #277 Session Free/Graph

**Product path:** Node4 Agent Runtime + platform ledger (ADR 0001). Graph is an optional orchestration capability on the same base, not a second booking channel.

---

## Problem Statement

Operators run a pentest (often with Session **Graph empty** = Free). The Agent may obtain real tool proof (shell/session), then call `finding(confirm)` and still produce **zero Case Findings**.

Typical failure (live Case example): Agent listed **platform ledger IDs from another Case** as `finding_id`, host returned `unknown finding id — invent-without-id forbidden`, Agent abandoned booking and wrote a markdown “report” claiming N re-verified issues. The Case ledger stayed empty.

Root causes in product terms:

1. **Split identity spaces** — platform vulnerability UUID vs run-local Store id vs “legacy confirm without id” feel like three systems; the Agent mixes them.
2. **Free vs Graph booking stories diverged in code** — Graph Store-first vs Free legacy; product intent is **one confirm contract** on the base Runtime.
3. **Cross-Case priors are readable but not bookable as “that row”** without clear rules — Agent treats prior IDs as confirmable Store ids.

Users need: **one tool path to write a finding**, stable ids, and this Case’s ledger to grow when confirm succeeds—whether or not Graph orchestration is mounted.

---

## Solution

**Base Runtime booking (all modes):**

- Agent books only via **`finding(confirm)`** (same tool Free or Graph).
- Host runs **open → L0 (existing book-path rules) → book** inside that call (atomic from Agent’s perspective).
- **`finding_id` is minted by host at successful open/book path on confirm** when missing; Agent must not invent UUIDs.
- **Foreign / unknown ids** (not in this Case’s bookable set): treat as **no id** → mint new; optional warning in tool result. Do not hard-fail the whole engagement on invent-without-id for platform prior UUIDs.
- **Cross-Case prior:** readable; re-confirm with fresh proof → **new row on this Case** (optional `related_prior_id`). Never overwrite another Case’s row by default.
- **#275** remains business identity (`vuln_type` + `location_key` …) for merge/New; **id** is row primary key / API / idempotency.
- **Graph** Feedback / validate_book are **orchestration overlays** that push the same confirm path—not a second write channel to the ledger.

Pair with the **UI projection Spec**: panel only reads the platform ledger; empty ledger ⇒ empty Findings (correct).

---

## User Stories

1. As an operator, I want a successful `finding(confirm)` to create a row on **this Case’s** Findings ledger, so that work is visible without trusting chat prose.
2. As an operator, I want Free (Graph empty) and Graph-mounted tasks to use the **same** booking tool, so that mode choice is about workflow depth not “how to file a bug.”
3. As an Agent, I want to call **one** confirm with title/location/poc/proof/severity/vuln_type, so that I do not manage Store feedback stages by hand on Free.
4. As an Agent, I want the host to **mint `finding_id`** when I omit it, so that I never invent UUIDs.
5. As an Agent, I want a wrong/prior platform UUID in `finding_id` to **not** block booking when proof is valid, so that a mistaken id does not zero out the engagement.
6. As an Agent, I want tool errors for L0 failures to be **actionable** (missing proof, severity, vuln_type), so that I can retry confirm rather than writing a markdown substitute ledger.
7. As an operator, I want cross-Case historical findings to remain **queryable**, so that I can avoid duplicate labor.
8. As an operator, I want re-verification of a prior issue on a **new** Case to create a **new** ledger row (optional link to prior), so that each Case has an honest deliverable list.
9. As an operator, I want #275 **New** badges to reflect ledger creates, so that UI counts match the database.
10. As a Graph-stage Main, I want validate_book / Feedback to **only** drive the same confirm path, so that I do not learn a second booking API.
11. As a pack author, I want hypothesis/queue confirmed rows to still require booking via Store/confirm rules without bypassing L0, so that exploration memory is not a ledger backdoor.
12. As Node Runtime, I want to own L0, mint, and emit `vuln_found` only after platform persist success, so that the Agent stays focused on testing.
13. As Platform, I want ingest to require the same closed `vuln_type` and severity fail-closed rules, so that bad books do not enter the ledger.
14. As an implementer, I want Free code paths to stop advertising a permanent “legacy confirm without Store” product story, so that docs and tools match one base contract.
15. As an operator, I want failed confirm (`vuln_found_error`) **not** to appear as a Findings list row, so that errors are not counted as vulns.
16. As an Agent, I want `finding(list)` (when used) to show ids in the **same space** as book results for this Case after mint, so that idempotent re-confirm is possible later.
17. As a security reviewer, I want invent-without-id to mean “Agent must not mint ids / forge bookable Store rows,” not “any UUID string kills confirm,” so that the gate matches the threat model.
18. As an operator, I want Graph-empty sessions to still book findings, so that default Free is a full worker seat, not a read-only chat.
19. As Node, I want process telemetry (tool traces) **not** auto-promoted to Findings without confirm, so that fail-closed booking stays intact.
20. As a dual-Spec consumer, I want this Spec to state write rules only and point UI read rules to the projection Spec, so that AFK agents do not merge two problem domains.

---

## Implementation Decisions

### Vocabulary

- **Base Runtime / Node:** Agent Runtime that runs tools, book-path, and process collection.
- **Free:** Participant Session with **Graph empty** — no Graph orchestration; still full tools + booking.
- **Graph mounted:** User-specified graph_id on Session — long-running orchestration **capability**; same booking tool.
- **finding_id:** Row primary key for Product finding identity on the wire and ledger alignment target after mint.
- **Identity (#275):** Business sameness for merge/New — not a substitute for inventing ids.

### Agent-facing contract

1. **Sole booking tool:** `finding(confirm)` for vuln/flag/auth-impact conclusions that must hit the Case ledger.
2. **Required fields (Wave1):** keep existing contract — title, location|url, description, poc, proof (grounded), severity, vuln_type (closed enum). L0 set = **current book-path** (no new proof philosophy in this Spec).
3. **finding_id optional on input:** if omitted or not in this Case bookable set → host mints new id on the open/book path.
4. **If finding_id is in this Case bookable set:** use for idempotent align/update per existing platform #275 rules.
5. **Agent must not invent ids.** No client-generated UUID requirement for success.
6. **Atomic confirm (Agent view):** one tool call; host performs open → L0 → book; on L0 fail return error, no ledger row.

### Host / Node

1. Book-path L0 remains fail-closed (proof anchoring, severity, vuln_type, etc. as today).
2. On confirm success path: mint id if needed; create Case evidence from proof (existing emit path); send platform `vuln_found` with structured outcome (`created` / id).
3. Replace Free-only “legacy confirm” product narrative with **base contract**; internal Store rows may still exist for Graph Feedback overlay but must not require Agent to pass Graph-only ids on Free.
4. Graph Feedback / validate_book: may inject confirmable ids and re-dispatch; final ledger write still confirm → platform.
5. **No auto-book** from shell/scanner output without confirm (process collection ≠ Finding).

### Platform

1. Persist vulnerabilities for `conversation_id` of the Case.
2. Cross-Case: confirm always creates/updates **this Case** per #275; optional `related_prior_id` (or equivalent) when Agent/host supplies prior reference — do not default-write into foreign Case rows.
3. `vuln_found_error` must not be merged into success Finding cards/lists.

### Migration / transition debt

1. Dual Store id vs platform id is **debt**; Wave1 minimum: confirm path mints/returns one id and platform row uses it (or platform returns canonical id and Node echoes it — single space after book).
2. Hard-graph-runner remaining a separate control-flow shell is OK for Wave1; booking contract must still match base.
3. Hypothesis queue (#274) stays non-booking; seed→confirm rules unchanged except id/confirm usability on Free.

### Explicit non-decisions (see Out of Scope)

- Todo honesty gates, forcing incomplete on zero books, NLP audit of “13/13” prose.
- Full Graph-as-plugin into single session-runner process.

---

## Testing Decisions

**Good tests:** assert **external behavior** at the booking boundary (tool result + ledger effect), not internal Store map layout.

### Primary seam — `finding(confirm)` (Node)

| Case | Expect |
|------|--------|
| Confirm without finding_id, valid L0 fields + grounded proof | ok; ledger-bound success; id present in result |
| Confirm with random/other-Case UUID as finding_id + valid proof | **not** invent-without-id hard-stop; behaves as no id → book/mint (or explicit map-to-new); this Case gains a row |
| Confirm missing vuln_type / severity / ungrounded proof | L0 fail; no success ledger row |
| Confirm twice same identity (#275) | platform merge/update rules; no duplicate New when not create |

**Prior art:** `node4` finding tool tests, `platform-evidence-e2e`, `node4-smoke` booking, book-path L0 tests, Spec #275 confirm wire tests.

### Secondary seam — platform `vuln_found` ingest

| Case | Expect |
|------|--------|
| Persist with conversation_id | row listed for that Case only |
| Fail-closed severity/vuln_type | error type, not success list row |

**Prior art:** `finding_dedupe`, vulnerability API tests, WS persist paths.

### Out of test scope for this Spec

- Right panel merge behavior (projection Spec).
- Todo tool done-flip.
- Full Graph stage runner integration beyond “confirm still works when Graph mounted.”

---

## Out of Scope

- Right panel / snapshot multi-source merge cleanup (→ projection Spec).
- Host enforcement of todo anti-fraud or chat number auditing.
- Mandatory incomplete terminal status when bookedFindings=0.
- Auto-promotion of tool output to Findings without confirm.
- Mint-at-first-listable-open as required Wave1 (confirm-time mint is Wave1).
- Replacing hard-graph-runner control flow with a pure plugin.
- Changing #275 identity key algorithm.
- Default seat finding booking policy changes.

---

## Further Notes

- Live incident class: Case `6194731f-…` / task `e5e2b7cd-…` — 75 tools, 0 booked, confirm ×3 invent-without-id on foreign platform ids.
- Black-cat / #274 hypothesis queue did not run on Free; this Spec does not require Graph for booking.
- Living doc: update when confirm contract or mint rules change; link from `docs/README.md`.
- Implement with Spec `product-state-ui-projection.md` for end-to-end “confirm → panel row”; either order OK if contracts hold.

### Wave 1 implementation notes (Node4)

- **Seam:** `node4/src/tools/finding.ts` `finding(confirm)` — Free and Graph share one path.
- **Bookable set:** this-run Finding Store row with `assertConfirmAllowed` (status `feedback_ok` + proof + severity). Only then Store-first field fill + `markBooked`.
- **Omit / foreign / unknown `finding_id`:** treat as no id → L0 (existing book-path) → host mints local `f_*` id; optional `related_prior_id` when input looked like a platform UUID; optional `booking_assist` warning in tool result. **Does not** hard-fail with `unknown finding id — invent-without-id forbidden`.
- **Invent-without-id** remains a threat-model phrase for “Agent must not mint bookable Store rows / forge ids,” not “any UUID string kills confirm.” Store API `assertConfirmAllowed("")` still rejects empty for callers that need a Store gate.
- **Tests:** `node4/src/tools/finding.confirm-id.test.ts`; Graph e2e paths in `process-quality-e2e` / `process-quality-store-first-e2e` updated for base contract.

### Wave 1 implementation notes (Platform #279 follow-up)

- **Seam:** `platform/backend/app/ws/router.py` `_persist_vulnerability` #275 match pool.
- **Case scope:** identity + CVE short-circuit queries filter `Vulnerability.conversation_id == this Case`. Cross-Case same identity → `created=True` new UUID row; prior Case row is never pinned/moved.
- **Optional link:** msg `related_prior_id` / `related_prior` is recorded on the discovery history JSONB event and echoed in the WS return dict when present (no DB migration).
- **Helpers / tests:** `case_scoped_rows` + `select_same_finding_candidates` in `finding_dedupe.py`; `platform/backend/tests/test_vuln_case_scope.py`.
