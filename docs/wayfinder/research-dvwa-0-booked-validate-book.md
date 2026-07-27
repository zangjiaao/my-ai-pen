# Research: DVWA tip dual-arm 0 booked / 14 unbookable at validate_book (#189)

**Map:** wayfinder #188 · **Issue:** #189  
**Branch:** `research/dvwa-0-booked-validate-book`  
**Verdict class:** **product contract gap** (primary) + **agent omission under correct host** (proximate)  
**Not:** host bug that wiped books · not proof/severity reject storm · not invent-without-id thrash  

---

## Executive answer

Tip dual-arm DVWA (`lab139-tip-dvwa-20260727-133709`) finished Expert Graph `app_assessment` with **`terminal=completed`**, **`validate_book` outcome=passed**, L0/L1 both pass — yet **Store booked_n=0**, **`findings/` empty**, and **all 14 `feedback_ok` rows** were exit-marked **`feedback_ok_not_confirmed_at_validate_book`**. Product state and event log show **zero `finding` tool invocations** for the whole run; the book stage ran **~5.8s** (06:11:01.139Z → 06:11:06.930Z) with only LLM wait, no confirm path. Host is behaving as coded: stage gate for `validate_book` requires **only a non-empty summary** (`require.summary`), and `unbookable_on_exit` **accounts leftovers as residual unbookable without failing the stage or the graph**. Juice same stamp and morning DVWA both entered `validate_book`, called `finding(list)` then many `finding(confirm, finding_id=…)`, and produced 15 / 23 booked rows. So zero booked is **not** “L0 rejected all books”; it is **agent never confirmed**, under a **contract that green-lights empty booking**.

---

## Causal chain (evidence-backed)

1. **Discovery produced confirmable Store rows.**  
   - `stage-2-auth_session` settlement: **5** `feedback_ok_ids`, packages success.  
   - `stage-3-class_probe` settlement: **9** `feedback_ok_ids` (8 success packages, 2 need_declare).  
   - Total distinct `feedback_ok` at closeout: **14**.  
   - Paths:  
     - `…/dvwa/lab139-tip-dvwa-20260727-133709/hard-graph/app_assessment/stage-2-auth_session/host-settlement-audit.json`  
     - `…/stage-3-class_probe/host-settlement-audit.json`  
     - `…/hard-graph/engagement-closeout.json` (`findings.feedback_ok_unbooked_ids` length 14)

2. **Later probe stages did not book (by design).**  
   Tool profile forbids `finding` until `validate_book` (`experts/pentest/graphs/hard/app_assessment.json` tools.allow).  
   `authz_logic` / `component` summaries are inventory-only (`surfaces=16`); no Store confirm path available.

3. **`validate_book` ran once, ~6 seconds, with no finding tools.**  
   - Events: `stage_start validate_book` **2026-07-27T06:11:01.139Z** → `stage_end … outcome=passed` **06:11:06.930Z**.  
   - Full-run `tool_output` name counts: session/browser/todo/shell/fact/http/… — **`finding`: 0**.  
   - `active_tool=finding` count: **0**.  
   - Path: `…/events.jsonl` (8705 lines); lab log `…/logs/dvwa.log` ends with `booked_findings:0` / `terminal=completed`.

4. **Settlement for book stage is summary-only honesty green.**  
   `stage-6-validate_book/host-settlement-audit.json`:  
   `package_count=0`, `feedback_ok_ids=[]`, `honesty.ok=true`, `structured.summary="surfaces=16"`, `summaryProvided=true`.  
   No package honesty failures → L0 honesty pass → L1 runs and passes (`engagement-closeout.json` feedback validate_book l0/l1 pass).

5. **Gate cannot fail empty booking.**  
   Graph def: `"require": { "summary": true }` only — no `booked_min` / confirm quota (`experts/pentest/graphs/hard/app_assessment.json` validate_book).  
   `evaluateStageGate` only checks summary / optional surfaces_min / candidates_min / structured.ok (`node4/src/runtime/hard-graph-runner.ts`).  
   Therefore `outcome=passed` with zero confirms is **in-contract**.

6. **Exit accounting marks every leftover feedback_ok unbookable.**  
   After stage finalize, if `stage.unbookable_on_exit`: for each Store row with `status === "feedback_ok"`, push  
   `{ finding_id, reason: "feedback_ok_not_confirmed_at_validate_book" }`  
   (`node4/src/runtime/hard-graph-stage-executor.ts`).  
   Closeout residual: `"14 feedback_ok unbooked; 14 explicit unbookable"`; **`process_complete: true`** because `terminal === "completed"`.  
   `book_outcomes` on run-result: `{ booked_n: 0, reject_hints_n: 16 }` (reject_hints slot reuses unbookable count accumulation — not confirm-error strings).

7. **Platform ledger never received books.**  
   - `findings/` directory **empty**.  
   - `task_complete.booked_findings: 0`.  
   - No confirm error strings to analyze — **attempts = 0**, not failed confirms.

8. **Agent omission is the proximate behavioral cause.**  
   Handoff candidates are title/location/claim/proof only — **no `finding_id` field** (`run-result.json` handoff.candidates keys).  
   Stage user prompt serializes surfaces/candidates/deadends, not a first-class `feedback_ok_ids` list (`stageUserPrompt` in `hard-graph-stage-executor.ts`).  
   Successful runs call **`finding(list)` then `finding(confirm, finding_id=…)`** (morning DVWA / Juice). Tip DVWA never did.

---

## Code map (file → behavior)

| File | Behavior relevant to 0-book green |
| --- | --- |
| `experts/pentest/graphs/hard/app_assessment.json` | `validate_book`: `intent=book`, `unbookable_on_exit: true`, `require: { summary: true }` only, tools allow `finding`, `max_retries: 0`. Success text says confirm feedback_ok — **not enforced by gate**. |
| `node4/src/runtime/hard-graph-definition.ts` | `HardGraphStageRequire` has `summary` / `surfaces_min` / `candidates_min` only — **no booked_min**. `unbookable_on_exit` documents leftover feedback_ok → unbookable at exit. |
| `node4/src/runtime/hard-graph-runner.ts` `evaluateStageGate` | Fail-closed on missing summary (and optional min counts). **Does not read Store booked count.** Stage pass → graph can complete. |
| `node4/src/runtime/hard-graph-stage-executor.ts` `stageIntentPromptLines` | Book intent: “confirm feedback_ok … leftover become explicit unbookable reasons.” |
| `… stage-executor.ts` unbookable block | On exit with `unbookable_on_exit`, snapshot all `feedback_ok` → reason **`feedback_ok_not_confirmed_at_validate_book`**. Does not flip stage outcome. |
| `… stage-executor.ts` `stageUserPrompt` | Handoff snapshot omits Store ids / closeout notes; candidates may lack ids. Agent must **`finding(list)`**. |
| `node4/src/tools/finding.ts` | Graph path: confirm requires Store `finding_id`, `assertConfirmAllowed` (status feedback_ok, proof, severity). Subagents cannot confirm. |
| `node4/src/runtime/finding-store.ts` | `assertConfirmAllowed` / `markBooked` — L0 book-path gates only apply **when confirm is attempted**. |
| `node4/src/runtime/engagement-closeout.ts` | Residual strings for unbooked/unbookable; **`process_complete = (terminal === "completed")`** even with residual unbookable. `booking_tail_ran` only when terminal=blocked + skipped stages + book stage ran. |
| `node4/src/runtime/l0-honesty-repair-brief.ts` | Booking-only stage detection via `unbookable_on_exit` / intent book — used for post-block tail briefing (Juice), not for min-book gate. |

**Answer to “can validate_book pass with zero confirms by design?”**  
**Yes.** Summary-only require + unbookable accounting without stage fail = green stage, green graph, residual closeout flags only.

---

## Contrast Juice / morning DVWA

| Metric | Tip DVWA (this issue) | Juice same stamp | Morning DVWA |
| --- | --- | --- | --- |
| Lab path | `lab-139-dual/20260727-133709/dvwa/…` | `…/juice/…` | `lab-139-parallel/20260727-073352/dvwa/…` |
| Graph terminal | **completed** | **blocked** (authz_logic L0 fail; component skipped) | **completed** |
| validate_book outcome | passed (~5.8s) | passed (~116s, honesty booking tail) | passed (~95s) |
| `finding` tool_outputs | **0** | 34 (15 confirm + list + paired) | 70 (25 confirm + list + …) |
| `finding(list)` in book stage | no | yes (2) | yes (2) |
| `finding(confirm)` | **0** | **15** (all with Store `finding_id`) | **25** in vb window (23 ledger files) |
| `findings/*.json` | **0** | **15** | **23** |
| Closeout booked_titles | **0** | **15** | **23** |
| unbookable / reason | **14** × `feedback_ok_not_confirmed_at_validate_book` | **0** | **0** |
| residual / process_complete | 14 unbooked; **process_complete true** | booking-only tail after upstream block; process_complete false | No residual flags |

**Juice takeaway:** Upstream **authz_logic honesty block** still ran booking-only tail (`booking_tail_ran: true`). Agent **did** list + confirm 15 feedback_ok rows → zero unbookable. Same host contract; different agent behavior on the book stage.

**Morning DVWA takeaway:** Same graph, same target family, completed with **23 booked** via explicit confirm loop after `finding(list)`. Proves host confirm path and Store ids were usable the same day; tip dual-arm failure is not “DVWA unbookable by proof bar.”

---

## Classification table

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| **Product contract gap** — stage/graph can complete with 0 books | **Primary — YES** | `require.summary` only; `evaluateStageGate` ignores booked_n; `unbookable_on_exit` residual-only; closeout `process_complete` true |
| **Agent omission under correct host** | **Proximate — YES** | 0 finding tool calls; ~6s book stage; 14 feedback_ok left unconfirmed |
| **Host bug** (false unbookable / lost Store / failed markBooked) | **No** | Store still holds 14 feedback_ok with severities; no confirms attempted; findings empty is consistent |
| **Tool-profile / proof / severity block** | **No** | No confirm attempts → no L0 reject strings; morning/Juice confirms succeeded on same code lineage |
| **Invent-without-id thrash** | **No** | Zero confirm attempts of any shape |
| **Upstream discovery failure** | **No** | 14 feedback_ok + rich candidates/proof_excerpt in handoff |

---

## What #161 still needs (design questions now sharp — not the fix)

Design ticket should decide **product policy**, not re-litigate this lab:

1. **Is empty booking a successful engagement?**  
   Today: yes (`terminal=completed`, `process_complete=true`) with residual_risk only.  
   Alternatives: fail/block `validate_book` when `feedback_ok_n > 0 && booked_delta == 0`; or soft residual class that demotes process_complete; or require `booked_min` / `confirm_attempt_min` in graph require.

2. **Should `unbookable_on_exit` be residual-only or gate-coupled?**  
   Today residual accounting is honest but **silent-green** for scores that key on terminal/stage pass. Decide whether leftover feedback_ok is residual risk vs stage L0 fail.

3. **Captain surface for confirmable ids on the book stage.**  
   Handoff candidates lack `finding_id`; stage prompt does not inject Store feedback_ok list (ids appear only if prior stage summary text still carries them — last stages often overwrite summary to `surfaces=N`).  
   Morning/Juice recovered via `finding(list)`; tip agent never listed. Design: host-inject confirmable ids into book-stage user prompt / repair brief vs rely on agent tool discipline alone.

4. **Metrics honesty for lab scorecards.**  
   Tip dual-arm looks “full process complete” with 0 books — scorecard must prefer closeout booked_n / unbookable over terminal alone (#161 lab interpretation).

5. **Do not invent answer keys or auto-confirm.**  
   Any gate should key off **Store feedback_ok left unconfirmed**, not target-specific expected vuln lists (AGENTS harness rules).

**Recommendation for next wayfinder design ticket:**  
**Decide whether `validate_book` (intent=book / `unbookable_on_exit`) is allowed to pass when Store still has `feedback_ok` rows.** That single policy decision unblocks gate shape, closeout `process_complete` semantics, and whether captain id injection is required vs optional steering.

---

## Sources

### Lab Product state (absolute)

- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/hard-graph/engagement-closeout.json`
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/hard-graph/run-result.json`
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/hard-graph/app_assessment/stage-2-auth_session/host-settlement-audit.json`
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/hard-graph/app_assessment/stage-3-class_probe/host-settlement-audit.json`
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/hard-graph/app_assessment/stage-6-validate_book/host-settlement-audit.json`
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/events.jsonl`
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/dvwa/lab139-tip-dvwa-20260727-133709/findings/` (empty)
- `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/logs/dvwa.log`
- Juice contrast: `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-dual/20260727-133709/juice/lab139-tip-juice-20260727-133709/hard-graph/engagement-closeout.json` (+ `findings/`, `events.jsonl`)
- Morning DVWA: `/mnt/d/Coding/my-ai-pen/node4/workspace/lab-139-parallel/20260727-073352/dvwa/lab139-dvwa-20260727-073352/hard-graph/engagement-closeout.json` (+ `findings/`, `events.jsonl`)

### Product source

- `experts/pentest/graphs/hard/app_assessment.json`
- `node4/src/runtime/hard-graph-definition.ts`
- `node4/src/runtime/hard-graph-runner.ts` (`evaluateStageGate`)
- `node4/src/runtime/hard-graph-stage-executor.ts` (book intent prompt, unbookable_on_exit, stageUserPrompt)
- `node4/src/tools/finding.ts`
- `node4/src/runtime/finding-store.ts`
- `node4/src/runtime/engagement-closeout.ts`
- `node4/src/runtime/l0-honesty-repair-brief.ts`

### Method notes

- Chat/thinking text alone not used as process truth; tool_output / Store / settlement / closeout / findings dir are authority.
- `dvwa.log` is mostly todo_updated noise; confirm absence confirmed via `events.jsonl` tool_name tallies.
