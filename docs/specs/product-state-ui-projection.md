# Spec: Product state → UI passive projection

**Status:** implemented (Wave 1: Findings + Evidence read path)  
**Issue:** [#280](https://github.com/zangjiaao/my-ai-pen/issues/280)  
**Related:** Base booking Spec ([#279](https://github.com/zangjiaao/my-ai-pen/issues/279), `docs/specs/base-booking-finding-id.md`); #275 New badge; #277 panel_agents; stream identity #276

**Product path:** Platform Case storage + frontend subscription; Node Agent Runtime collects and writes; UI does not trust Agent prose as ledger.

### Living status (Wave1)

| Area | Behavior now |
|------|----------------|
| Snapshot `findings` | `findings_for_panel` → DB `vulnerabilities` only (`conversation_snapshot.py`) |
| Snapshot `evidence` | `evidence_for_panel` → evidence table only; no `tool_call` fallback |
| FE Case Findings | Snapshot arrays (empty wins) + `vuln_found` upsert by ledger `id`; no `mergeByTitle` / Strix shadow |
| FE chat cards | Still render; `snapshotFromMessages` does **not** set findings/evidence |
| New badge | Unchanged (#275 `created` / `is_new`) |
| Tests | `platform/backend/tests/test_conversation_snapshot_purity.py` |

---

## Problem Statement

The right panel is already event-driven in places (`vuln_found`, `evidence_created`, `panel_agents`), but **Findings/Evidence lists are multi-source merges**: platform DB ∪ chat messages ∪ checkpoint shadows ∪ legacy Strix title merges. That creates a second, informal “list” next to the ledger.

Operators and Agents then experience:

- Chat claims “N issues verified” while the ledger is empty (or the reverse if shadows inflate the panel).
- Mental model that someone must “maintain the panel.”
- Risk of Free vs Graph feeling like different UI pipelines even when both share ConversationPage.

Product intent: **Agent is an employee in an environment; Node Runtime collects from execution; Platform stores Findings/Evidence; the panel is a hook-style projection of Product state.** Agent attention stays on testing, not on list hygiene.

---

## Solution

### Roles

| Role | Responsibility |
|------|----------------|
| **Agent** | Complete user work via Free / Graph / other workflows; call simple tools; **does not** maintain lists or refresh the panel |
| **Node (Agent Runtime)** | Run tools; book-path; **passively collect** process data from execution; emit structured events after host decisions; **never** auto-book Findings without `finding(confirm)` |
| **Platform** | Central store for vulnerabilities + evidence (Case-scoped); snapshot + WS for clients |
| **Frontend right panel** | **Subscribe/project** SoT; empty ledger ⇒ empty Findings (**correct**) |

### Write vs read (Findings)

```text
Agent finding(confirm)
  → Node book-path (L0, mint)
  → Platform vulnerabilities + Case evidence
  → vuln_found (persist success only)
  → Right panel Findings upsert / snapshot reload
```

Chat may show a vuln **card** for operator reading; **cards must not feed** the Findings array used by the right panel.

### Wave 1 (normative implementation)

1. **Findings SoT** = `vulnerabilities` for this `conversation_id` only.
2. **Snapshot `findings`** = DB query only — **remove** merge of message-derived findings and checkpoint shadow vulns into the panel list.
3. **Live updates** = `vuln_found` after successful persist (or refetch snapshot); `vuln_found_error` never joins Findings.
4. **Evidence SoT** = evidence table / book-created rows + `evidence_created`; **remove** tool_call message fallback as panel Evidence source.
5. **New badge** = ledger `created` / `is_new` only (#275).
6. Frontend **stops** `mergeByTitle` / Strix shadow vulnerabilities into Case Findings for Wave1 target behavior.

### Later waves (Spec target architecture, not Wave1 DoD)

- Case **Surface** coverage projection (same hook pattern) — **owned by** [`case-surface-ledger.md`](case-surface-ledger.md) / Spec [#368](https://github.com/zangjiaao/my-ai-pen/issues/368) (Node SQLite working store + Platform dual-write; UI Surface tab projects ledger only). **Not** long-lived Host/Service asset inventory — that is Spec [#322](https://github.com/zangjiaao/my-ai-pen/issues/322) and **depends on** #368 for Surface object semantics.
- Request recording / Activity replacement — **owned by** [`traffic-audit-activity.md`](traffic-audit-activity.md) (Case traffic audit; Runtime hook collect → store/project → panel).
- Agent tree / status already largely event-projected — align docs only unless bugs found.
- Todo remains Agent-written Product state projected read-only; **no** anti-fraud todo gates in this Spec (explicit product choice).

### Pairing

Booking/id rules live in **base-booking-finding-id** Spec. This Spec owns **read model purity** and role split (Node collect vs Platform store vs UI project).

---

## User Stories

1. As an operator, I want Findings to show only ledger rows for this Case, so that empty means nothing was booked.
2. As an operator, I want a successful book to add one Findings row without refreshing manually, so that the panel feels live.
3. As an operator, I want Agent chat “we verified 13 issues” to **not** change the Findings count, so that prose cannot fake the ledger.
4. As an operator, I want Evidence in the panel to match book-created evidence, so that tool noise is not listed as Case evidence.
5. As an operator, I want chat vuln cards to remain openable, so that I can read context without treating chat as the ledger.
6. As an Agent, I want to ignore the right panel entirely, so that I only call tools.
7. As Node Runtime, I want to collect process data from execution without the Agent calling “update panel,” so that Free and Graph share one collection model.
8. As Node Runtime, I want to refuse auto-writing Findings without confirm, so that collection does not bypass fail-closed booking.
9. As Platform, I want snapshot findings to be a pure DB read model, so that clients cannot disagree on list membership.
10. As a frontend engineer, I want a single upsert key (ledger id) for Findings WS events, so that merge-by-title dies.
11. As an operator on Free, I want the same Findings projection as on Graph, so that mode is workflow not UI pipeline.
12. As an operator, I want New badges only on true ledger creates, so that rediscovery is quiet (#275).
13. As an operator, I want failed books to show errors in chat/stream without creating Findings rows, so that errors ≠ vulns.
14. As a future request-log feature owner, I want the same projection pattern (Runtime collect → store/project → panel), so that Activity replacement does not invent Agent-maintained lists.
15. As a future attack-surface owner, I want surface ledger projection without Agent “publish surface to UI” tools, so that recon stays tool-native.
16. As an implementer, I want Wave1 DoD limited to Findings+Evidence read purity, so that the issue is AFK-finishable.
17. As an operator, I want assets and agent tree to keep working during Wave1, so that tightening findings does not blank the whole panel.
18. As a dual-Spec consumer, I want clear links to booking Spec for write rules, so that UI work does not re-litigate L0.
19. As a regression tester, I want a Case with 0 vulns in DB and many chat claims to show 0 Findings, so that the core invariant is locked.
20. As a regression tester, I want a Case with 1 DB vuln and 0 chat cards to show 1 Finding after snapshot, so that DB wins over silence in chat.

---

## Implementation Decisions

### SoT table (Wave1)

| Surface | Write | Read SoT for right panel |
|---------|-------|---------------------------|
| Findings | `finding(confirm)` → Node → platform vulnerabilities | DB + `vuln_found` success |
| Evidence | Book-time host evidence create | evidence DB + `evidence_created` |
| Assets | Existing platform asset rules | unchanged Wave1 unless broken by snapshot edits |
| Agent tree | Node panel_agents / status | existing WS/checkpoint (document as projection) |
| Todo | Agent todo tool | plan_tree projection (no new honesty gates) |

### Snapshot

- `conversation_snapshot.findings`: **only** DB rows for conversation (plus stable serialization fields needed by UI).
- `conversation_snapshot.evidence`: **only** persisted evidence rows (no tool_call fallback into this array for panel).
- Counts in snapshot summary must match those arrays.

### WebSocket

- `vuln_found`: payload = **post-persist** shape; frontend upserts by ledger id; optional snapshot refresh remains OK.
- `vuln_found_error`: do not upsert into findings state.
- `evidence_created`: upsert evidence list by evidence_id.

### Frontend

- Right panel Findings prop source: React state filled only from snapshot findings + vuln_found success handlers (and user edits if product allows status changes via API).
- **Remove / disable** paths that merge chat `vuln_card` / message archaeology / Strix `vulnerabilities` blobs into Case findings state (Wave1 target).
- Chat rendering of cards stays; isolation invariant: **card renderer must not call setFindings**.

### Node

- Continues to emit platform messages after book; no new Agent tool “panel_upsert.”
- Process collection for future surfaces must not write vulnerabilities table without confirm.

### Free vs Graph

- No separate panel adapters; same ConversationPage projection; Graph may emit more status/plan events only.

---

## Testing Decisions

**Good tests:** assert list membership and counts against **DB/fixture ledger**, not against chat fixtures alone.

### Primary seam — conversation snapshot findings/evidence

| Case | Expect |
|------|--------|
| DB has 0 vulns, messages contain vuln-like content | snapshot findings length 0 |
| DB has N vulns | snapshot findings length N; ids match DB |
| Evidence only in tool messages, none in evidence table | snapshot evidence length 0 for panel SoT |

**Prior art:** `conversation_snapshot` service tests; backend WS persist tests.

### Secondary seam — frontend projection invariant

| Case | Expect |
|------|--------|
| Unit/integration: applying vuln_found_error | findings state unchanged |
| Unit: chat replay without DB | does not populate findings store (if test harness exists) |

Prefer pure functions extracting “projectFindings(snapshot, events)” if extracted; otherwise backend snapshot purity is enough for Wave1.

### Cross-Spec smoke (optional)

- Book via Node test double → DB row → snapshot contains row (may live in e2e later).

---

## Out of Scope

- Base confirm L0/mint/id algorithm details (→ booking Spec).
- Todo done-flip validation / anti-fake harness.
- Zero-book task terminal status policy.
- Implementing request recording / Activity replacement (architecture only).
- Full attack-surface productization (architecture only).
- Redesigning AgentCollaborationTree visuals.
- Forcing Graph mount for projection to work.

---

## Further Notes

- Wave1 landed: snapshot findings/evidence are ledger-pure; FE no longer merges chat/Strix shadows into Case Findings. Helpers `message_findings` / `checkpoint_findings` / `message_evidence` remain for parsers/tests but are **not** panel SoT.
- Empty Findings with a long Agent report is **correct** if nothing was booked — pair with booking Spec to fix zero-book causes.
- **#280 live WS fail-closed:** platform `apply_vuln_persist_result` rewrites outgoing frames when `_persist_vulnerability` returns `None` or a structured `vuln_found_error` (known gates: missing conversation, status≠confirmed, evidence_ids empty/missing in DB, severity/vuln_type, exception). Clients must never receive a bare pre-persist `vuln_found` success for the room; FE ignores `vuln_found_error` for Findings upsert.
- Living doc: update when SoT or Wave scope changes; link from `docs/README.md`.
