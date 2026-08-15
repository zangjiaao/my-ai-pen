# Spec: Case Status ledger + atomic time UI

**Status:** Implementable Spec (product contract)  
**Tracker:** [#323](https://github.com/zangjiaao/my-ai-pen/issues/323)  
**Implementation tickets (frontier, no mutual blockers):**  
- [#324](https://github.com/zangjiaao/my-ai-pen/issues/324) — S1 Case metering + Status D1  
- [#325](https://github.com/zangjiaao/my-ai-pen/issues/325) — S2 work-burst clock + composer timer + B1  
- [#326](https://github.com/zangjiaao/my-ai-pen/issues/326) — UI stream stamps + suppress infra status  

**Decision source:** Product grill (RightPanel Case positioning; Status metrics; atomic time placement; collaboration-tree usage rows).

**Product path:** Node4 Graph × Pi + platform conversation UI (ADR 0001).  
**Amends (thin):**  
- `docs/prd.md` P1 RightPanel Status bullets (elapsed-first strip → Case ledger + collab/Tasks; time leaves Status main chrome).  
- `docs/specs/product-state-ui-projection.md` / Spec [#280](https://github.com/zangjiaao/my-ai-pen/issues/280) — Status / collaboration-tree / stream time as **projections** of Case/Participant work ledger, not Agent prose.  
- `docs/specs/participant-session.md` / Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) — Participant usage rollup hangs on Session identity; Case `case_run` is sum.  
- `docs/specs/task-map-history.md` / Spec [#321](https://github.com/zangjiaao/my-ai-pen/issues/321) — **decoupled**: Task Map archive/seal **must not** reset Case token or work-seconds ledger.

**Does not amend:** Finding Store / book-path L0, intent NLP ban (`AGENTS.md`), #321 Task Map lifecycle events, Default seat never-Graph, Worker audit dialog content (#308).

---

## Problem Statement

Operators use the right panel to understand **Case** situation (shared multi-agent work), but Status still mixes **single-run stopwatch** chrome (elapsed / start / end) with partial token rollups and **AgentRow action narration** (“本轮工作已结束”, tool progress phrases). That fights the product model:

1. **Case storage** is multi-Agent shared truth; the panel should project Case situation, not pretend every strip is the current burst only.  
2. **Time** and **cost** answer different questions; stuffing both into one Status hero confuses “how long has this Case been working?” with “what is this chat turn doing?”  
3. **Internal system notices** (e.g. `tooling_health`) appear as centered chat chrome and feel like product status rather than infrastructure.  
4. Token/cost placement is unclear: Case total vs per-Participant vs “this round,” and whether **Sub** spend is included.

---

## Solution

### Positioning (locked)

| Layer | Subject | Role |
|-------|---------|------|
| **Case** | One conversation = one Case | Shared Findings / evidence / scope / **metering ledger** |
| **Right panel** | Case **container** with **layered projection (P1′)** | Not every block is the same grain |
| **Status tab** | Collab + Tasks + **Case billing presentation** | No main elapsed/start/end hero |
| **Tasks** | Participant Session live map + #321 history | Session write path; multi-role maps not merged into one fake list |
| **Findings / Surface / Traffic** | Case assets | Unchanged ownership |

### Status metering presentation (D1 + L1)

| UI locus | Shows | Subject |
|----------|--------|---------|
| Collaboration section header (replaces primary `N/M active` emphasis) | **Total tokens + total cost** (active count optional secondary) | **Case** cumulative, all Participants + Subs |
| Main / seat **AgentRow** secondary line | **Model · request count · tokens** (optional cost) | **That Participant cumulative**, Subs **rolled into parent** |
| Sub rows | Short usage and/or status only | That Sub’s own usage (parent already includes) |
| AgentRow | **No** tool/work-content summary line (“本轮工作已结束”, friendly tool progress) | Runtime state via **dot + status badge + active** only |

**Ledger rules (L1 + Z1):**

- Case **monotonic** accumulation of LLM **requests / tokens / cost** across all Participant Sessions and bursts.  
- **Includes Sub** consumption; Main and Sub **must not double-count** the same call.  
- Same rule for all three scalars (no “tokens with Sub, cost without”).  
- **Never reset** within the conversation lifetime (Z1). New conversation = new Case.  
- Task Map archive / seal / replace (#321) **does not** clear this ledger.  
- Failed/interrupted calls that actually completed at the provider **count**; unsent calls do not. Retried waves count each real request.

### Time: backend ledger vs three atomic UI placements (V1 + C1 + B1)

**Backend Case work-time ledger (retained, not Status-main):**

| Rule | Lock |
|------|------|
| **Start anchor (E1)** | First successful **task_assign / work-burst enter**; write-once `started_at` |
| **Work seconds (S)** | Sum of busy intervals — **not** wall-clock `now − started_at` |
| **Parallel (U)** | **Union** of busy intervals (at least one worker busy), not sum of Main+Sub seconds |
| **Authorize wait (H1)** | Pending user authorize/cancel is **not** busy; Task package status **`paused`** (yellow light; not covered by `working` blue; alias `pause` normalizes to `paused`) |
| **Park / incomplete** | Harness half-settle (user interrupt / Session continue). No live task. Light is **yellow** (`incomplete`) — same wait family as paused. Sticky `working` must not repaint it blue. |
| **Same-user-message auto-retry (R1)** | Same work-burst; mergeable busy until final success/abandon |
| **API error** | Closes **current** busy interval; updates last activity; **does not** close Case or clear `started_at` |
| **Reset (Z1)** | No mid-Case reset |

**UI placements (Status does not own time):**

| Placement | Behavior |
|-----------|----------|
| **Chat day/time stamps** | Chat-app style date separators / message times; long-lived |
| **Composer live timer** (near Send) | Visible only while Case has active work-burst busy (**C1**); pauses on authorize; **stops and disappears** on burst settle |
| **List-tail Working chrome** | Same **C1** seconds as composer (work-burst ledger). Not mount-local — remount / route change must resume, not restart. |
| **Agent result anchor** (bottom-right of burst result) | **One duration per work-burst (B1)** — finalized work-seconds from the same C1 clock; long-lived; not on every tool/thinking card |
| **Internal status notices** | Do **not** render infra notices such as `tooling_health` as chat status chrome |

**C1 clock identity:** starts when the Case enters working/busy after a user-triggered work-burst (not first agent token); advances on busy union; pauses authorize; settles with burst terminal state.

**B1 anchor:** single finalized duration on the burst’s **result anchor** (prefer last user-visible agent result for that burst; if only tools/failure copy exist, still one anchor so the number is not lost).

---

## Product locks (grill)

| # | Lock |
|---|------|
| L1 | Right panel = Case container; **P1′** layered projection. |
| L2 | Status main chrome = collab + Tasks + Case billing (**no** elapsed hero). |
| L3 | Case token/request/cost ledger = monotonic, **includes Sub**, no double-count, **Z1** no reset. |
| L4 | D1 presentation: header Case totals; AgentRow Participant cumulative + model + requests; no work-content summary. |
| L5 | Work seconds = **S + U + H1 + R1 + E1**; API fail closes interval only. |
| L6 | Time UI = chat stamps + composer live timer + B1 burst anchor; not Status main. |
| L7 | Composer timer = C1 busy; disappear on settle. |
| L8 | One duration per work-burst on result anchor (B1). |
| L9 | Hide internal system status notices (e.g. `tooling_health`) from stream chrome. |
| L10 | #321 Task Map history **compatible**; archive does not reset metering. |
| L11 | No free-text NLP to invent billing periods or “new engagement” resets. |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Case metering ledger** | Monotonic Case-level LLM requests / tokens / cost (+ write-once work start + busy intervals). |
| **Participant usage** | Per `conversation_id + expert_id` (Participant Session) rollup of usage; children Subs fold into parent for row display. |
| **Work-burst** | One user-triggered working interval (send → busy → settle), including same-message auto-retries (R1). |
| **Busy union** | Timeline length where at least one counted worker is busy (Main and/or Subs). |
| **Result anchor** | Single UI locus for that burst’s finalized work-seconds (B1). |
| **Live composer timer** | Ephemeral C1 display; not a second ledger. |

---

## User Stories

1. As an operator, I want the right panel to feel like the Case situation board, so that multi-agent shared work is visible in one place.  
2. As an operator, I want Status to emphasize who is collaborating and what Tasks are owed, so that I am not distracted by a run stopwatch.  
3. As an operator, I want Case total tokens and cost at the collaboration header, so that I see the true bill for the whole Case.  
4. As an operator, I want each Participant row to show model, request count, and tokens, so that I can attribute spend by seat.  
5. As an operator, I want Sub spend included in Case totals and rolled into the parent Participant row, so that Graph probe cost is not hidden.  
6. As an operator, I want Agent rows not to narrate tool progress or “本轮工作已结束” as fake intelligence, so that status stays honest and quiet.  
7. As an operator, I want runtime state via dots and badges only, so that I still know running vs done.  
8. As an operator, I want token numbers never to reset when I @ another expert, so that Case accounting stays trustworthy.  
9. As an operator, I want Task Map archive not to wipe tokens, so that planning history and billing stay independent.  
10. As an operator, I want a small timer by Send while work is in flight, so that I see factual busy time now.  
11. As an operator, I want that timer to pause while waiting for my authorize, so that human wait is not billed as machine work time.  
12. As an operator, I want the timer to disappear when the burst settles, so that idle chrome stays clean.  
13. As an operator, I want finalized burst duration on the agent result bottom-right, so that I can re-read how long that job took later.  
14. As an operator, I want only one duration per burst, so that tool cards do not spam clocks.  
15. As an operator, I want chat date/time stamps like a messenger, so that I can orient in long threads.  
16. As an operator, I want internal notices like tooling_health hidden, so that infrastructure noise is not product UI.  
17. As an operator, I want model API failure to stop the live timer without “closing” the Case, so that I can send again and keep cumulative meters.  
18. As an operator, I want same-message automatic retries to count as one burst clock, so that retries do not look like multiple jobs.  
19. As an operator, I want parallel Subs not to multiply Case work-seconds by headcount, so that duration stays wall-busy-union honest.  
20. As an operator, I want first work dispatch to set Case start once, so that the ledger has a stable anchor even if UI hides it.  
21. As a multi-role Case operator, I want each Session’s Tasks history per #321, so that maps stay owned and reviewable.  
22. As a multi-role Case operator, I want Status not to merge all Sessions into one fake task list for billing, so that Tasks and meters stay coherent.  
23. As an Expert Agent author, I want usage reporting to remain structured host events, so that I do not invent UI strings for cost.  
24. As a platform implementer, I want one Case metering rollup API in snapshot/WS, so that FE does not re-sum races.  
25. As a platform implementer, I want Participant usage fields on roster rows, so that AgentRow D1 is data-driven.  
26. As a platform implementer, I want busy interval records or equivalent for C1/B1, so that reload shows the same finalized duration.  
27. As a platform implementer, I want Sub usage attributed once, so that double-count tests fail closed.  
28. As a frontend implementer, I want Status to drop Strix-style elapsed hero, so that layout matches the Spec.  
29. As a frontend implementer, I want MessageRenderer to suppress infra status types, so that tooling_health never appears.  
30. As a frontend implementer, I want composer timer bound to conversation_working/busy, so that Send chrome stays honest.  
31. As a QA engineer, I want fixtures for multi-Participant token sum, so that Case header matches roster.  
32. As a QA engineer, I want fixtures for Sub-included totals, so that Graph-heavy bursts cannot under-report.  
33. As a QA engineer, I want fixtures that authorize gaps do not advance work-seconds, so that H1 holds.  
34. As a QA engineer, I want fixtures that Z1 holds across handoff and new Graph, so that meters never silently zero.  
35. As a QA engineer, I want fixtures that #321 archive leaves case_run usage unchanged, so that decoupling holds.  
36. As a QA engineer, I want projection tests that AgentRow has no work-summary string requirement, so that narration cannot regress.  
37. As a QA engineer, I want stream tests that B1 attaches one duration meta per burst, so that multi-bubble bursts stay single-anchored.  
38. As an operator, I want optional active worker count secondary to cost, so that liveness is still glanceable.  
39. As an operator, I want empty Case before first work-burst to show no fake timer and empty/zero meters honestly, so that “not started” is clear.  
40. As a reviewer, I want living docs cross-linked from README and thin PRD amend notes, so that precedence stays clear.

---

## Implementation Decisions

1. **Primary seam (S1) — Case metering ledger:** Platform-owned Case rollup (`case_run`-class) and per-Participant usage. Monotonic sum of requests/tokens/cost including Sub; write-once work start; no reset on handoff/Graph/Task Map archive. Snapshot + WS expose Case totals and per-Participant (and Sub) usage for D1.  
2. **Secondary seam (S2) — Work-burst time ledger:** Busy intervals driven by existing work-burst / `conversation_working` / worker busy truth. Implement S, U, H1, R1, E1, fail-closes-interval. Persist enough for B1 reload (finalized seconds per burst id). Composer timer and result-anchor duration are views of this seam, not independent clocks.  
3. **Tertiary seam (UI) — Status + stream + composer projection:**  
   - Status: remove elapsed/start/end main summary; header Case tok+cost; AgentRow model/requests/tokens; strip work-content summary.  
   - Stream: chat date/time stamps; suppress infra status notices; B1 duration on result anchor.  
   - Composer: live C1 timer by Send; hide when not busy.  
4. **Double-count policy:** Prefer Sub-reported usage as source for child work; parent rollup = own + children; Case = sum of Participants without recounting.  
5. **Model field:** Display the model id/name associated with that Participant’s metered usage (last-known or primary configured model for the seat—product may pick one stable field; must not invent per-tool marketing names).  
6. **Active count:** May remain as secondary mono text; must not replace Case totals as the primary header metric.  
7. **Internal status denylist (v1):** At least infra/health style status payloads (including `tooling_health` and equivalent opaque system health tokens). User-meaningful system gists already governed by other Specs (e.g. engagement closeout) are not reclassified as infra by this Spec without explicit amend.  
8. **No NLP engagement reset** and no keyword “new scan” clearing meters.  
9. **Docs:** Living Spec here; thin PRD Status bullet update in same change set as behavior; index in `docs/README.md`.  
10. **#321:** No change to Task Map E1–E6; only assert metering independence in tests.

### Clock sketch (normative)

```
on first task_assign / work-burst enter (E1):
  if case.started_at empty: case.started_at = now

on worker busy start (Main or Sub):
  open or extend busy interval (union merge)

on authorize pending:
  pause accrual (H1) — interval not busy

on same-message auto-retry:
  keep same work_burst_id (R1)

on burst settle (success | fail | interrupt terminal):
  close busy intervals for that burst
  finalize work_seconds[burst_id] = busy_union_length
  composer timer hides
  attach work_seconds to result_anchor for burst_id (B1)

on LLM usage event:
  add to Sub or Participant without double-count
  recompute case_run totals (L1)
```

---

## Testing Decisions

**Good tests** assert external behavior at S1 / S2 / UI only: rollup numbers, reset refusal, busy-second math under parallel/authorize/retry, snapshot fields, and visible projection contracts—not CSS class names or internal helper identifiers.

| Seam | Example external behaviors |
|------|----------------------------|
| **S1** | Two Participants + Sub tokens → Case total = sum once; handoff / new Graph / #321 archive → totals unchanged; double-count fixture fails if Sub folded twice; snapshot exposes case + participant usage. |
| **S2** | Main 10m with overlapping Subs → union ≈ 10m not 10+8+8; authorize gap excluded; retry same burst id; API fail finalizes seconds and leaves case open; reload returns same finalized burst seconds. |
| **UI** | Status has no elapsed hero requirement; header shows Case tok+cost; AgentRow has model/requests/tokens and no required work-summary string; tooling_health not rendered; composer timer present only when working; one B1 duration per burst after settle. |

**Prior art:** `test_case_participants` / `recompute_case_run`; conversation snapshot purity (#280); `conversation_working` / work_status paths; RightPanel / AgentCollaborationTree tests; MessageRenderer status rendering; #321 projection tests when present.

**Fixtures:** Synthetic usage events and busy interval timelines; no live LLM required for ledger math.

### Test seams (normative)

| ID | Seam | Role |
|----|------|------|
| **S1** | Case metering ledger (tokens/requests/cost + participant rollup + Z1) | Primary |
| **S2** | Work-burst time ledger (E1/S/U/H1/R1 + B1 persistence) | Secondary |
| **UI** | Status collab projection + stream stamps/suppression + composer timer + B1 anchor | Tertiary |

Ideal: one platform ledger kernel behind S1+S2; UI tests consume projected fields only.

---

## Out of Scope

- Redesigning Findings / Surface / Traffic SoT.  
- Implementing full #321 Task Map UI (owned by #321).  
- Per-stage history in Tasks dropdown.  
- Real payment / invoicing; cost remains usage estimate hooks.  
- Resurrecting Soft scenario Graph or Node5.  
- Keyword/NLP engagement or meter-period detection.  
- Making open todos a settlement gate.  
- Worker process audit dialog redesign (#308) beyond optional navigation from rows.  
- Mandatory retention GC for burst duration history beyond Case lifetime.  
- Showing Case start/last_active as Status main fields (backend may keep; UI main path does not).  
- Multi-live writable Task Maps.  
- Translating raw tool stdout as time/cost chrome.

---

## Further Notes

- **Why not keep elapsed on Status:** Status is Case situation + bill; wall or work clocks belong next to chat action (composer) and chat memory (B1).  
- **Why D1 not “row = this burst only”:** Avoids fighting Case totals; burst time is the duration story, burst cost is optional later.  
- **Why busy union not sum:** Duration is time narrative; capacity-seconds would inflate with Sub fan-out while L1 already prices tokens.  
- **Why hide tooling_health:** Internal harness/platform health is not operator chat content; date stamps reclaim that visual channel.  
- **Relation to PRD:** Replace “Status（Case 级 elapsed / tokens / target…）” framing with Case tokens/cost + collab + Tasks; target remains via Surface/scope, not Status hero.  
- **Living doc path:** `docs/specs/case-status-ledger-time-ui.md`
