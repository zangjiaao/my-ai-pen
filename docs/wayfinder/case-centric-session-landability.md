# Research: Case-centric session model landability (platform + Node4)

**Ticket:** [#91](https://github.com/zangjiaao/my-ai-pen/issues/91)  
**Parent map:** [#81](https://github.com/zangjiaao/my-ai-pen/issues/81) Wayfinder: In-envelope retest / Graph re-entry  
**Canonical path:** `docs/wayfinder/case-centric-session-landability.md`  
**Branch:** `research/case-centric-session-landability`  
**Date:** 2026-07-25  
**Method:** Primary-source inventory (platform + Node4 + living specs). Reuses #82 inventory for retest seams only (do not re-do). **No product implementation.**

**Product law under test (C1 intent — locked in grill #83 interim / map #81; not fully productized):**

1. **Case** = one platform collaboration session (long-lived shared intel: target, RoE, findings, ledger).
2. **Agent session** = talk with Default or Expert **inside** Case; multi-agent share via Case.
3. **Graph run** = structured work episode inside Expert (repeatable); not a user-facing session that ends the Case.
4. After Graph completes, same Case / same Agent conversation continues; context must not drop.
5. Operator scenarios (D1) stay in Case — never productize free OMP “new session” as truth:
   - Dig deeper after findings (coverage/risk challenge → re-probe in Graph envelope)
   - Finding retest after fix (not free `engagement=retest` OMP)
   - Continue-chat Q&A with context (default no full Graph re-run)
6. Internal new `task_id` / `workspace/{taskId}` OK; v1 does **not** require resume of the same hard-graph directory.

**Prior research reused (summary only):**  
[Research: current retest path vs Expert Graph re-entry seams](https://github.com/zangjiaao/my-ai-pen/issues/82) → branch `research/retest-graph-reentry-seams`, path `docs/wayfinder/retest-graph-reentry-seams.md`, commit `b85f4a6`. Product vuln retest is free OMP on a **new** conversation; continue-chat was partial at #82 time; stage/targeted re-entry missing. **Mainline since #82:** C1 `graph_execution=continue` landed in product code (e.g. `c61270f` / related C1 commits) — this note re-verifies as-built for Case identity.

---

## 1. Executive verdict

| Overall | **Landable with glue** |
|---------|------------------------|
| Case identity (1 Conversation = 1 Case) | **Landable now** — shipped product model |
| Multi-agent share via Case | **Landable now** — participants + `case_context` |
| Graph run as work episode (does not end Case) | **Landable now** — `task_complete` settles burst; conversation row survives |
| Post-Graph same Case + no auto full re-run | **Landable now** (with shipped C1 glue) — status-sticky `graph_execution=continue` |
| Scenario 3 continue-chat | **Landable now** |
| Scenario 1 dig-deeper in Graph envelope | **Landable with glue** — same Case works as free-in-envelope after complete; **no** structured dig-deeper / stage re-entry envelope |
| Scenario 2 finding retest in Case | **Blocked** as product truth today — always **new Conversation** + free pack alias |

**World rewrite not required.** Hard Graph runner, Case sticky RoE, conversation lifecycle, and Node `taskDir` isolation already match C1’s internal-task model. Construction must **stop productizing new-session free retest** and add **structured re-entry fields** for dig-deeper / finding retest — not invent a second collaboration identity.

---

## 2. C1 clause → landability matrix

| # | C1 clause | Status | Evidence (path / symbol) |
|---|-----------|--------|---------------------------|
| 1 | Case = one platform collaboration session (target, RoE, findings, ledger) | **Landable now** | Spec: `docs/specs/expert-offers.md` §Case (v1) — “1 conversation (session) = 1 Case”. Code: `Conversation` model (`platform/backend/app/models/conversation.py`); Case API `GET/PUT /{conv_id}/case` (`conversations.py` `get_conversation_case` / `put_conversation_case`); RoE sticky via `case_engagement.case_fields_from_context` / `merge_case_into_context` / `roe_payload_for_task_assign`. Findings/evidence conversation-scoped (+ ledger may outlive: `Vulnerability.conversation_id` nullable). |
| 2 | Agent session = Default or Expert talk **inside** Case; multi-agent via Case share | **Landable now** | Spec: `expert-offers.md` “对话（共享 session）”; PRD §4.1 “1 会话 = 1 Case” participants. Code: WS routes participant → engagement (`ws/router.py` user_message path ~4160–4235); roster `case_participants.upsert_participant` / `participants_map`; handoff authorize `_apply_authorized_handoff`; dispatch attaches `case_context` (`_attach_case_context_to_task_assign` → `case_context.load_case_context_for_conversation`). |
| 3 | Graph run = work episode; does not end Case as user session | **Landable now** | Hard path: `session-runner.ts` → `runHardGraphExpertTask` → settle → return; platform on `task_complete` sets conversation terminal status (`ws/router.py` ~703–732; `conversation_state.transition_conversation`). Conversation **row and messages remain**; status may return to `running` on next assign (`CONVERSATION_TRANSITIONS`: `completed → running`). New assign gets **new** `task_id` (`_dispatch_task_assign_to_node` / `_task_assign_from_user_message` uuid). |
| 4 | After Graph complete: same Case / same Agent conversation; context not dropped | **Landable now** (glue shipped) | Platform: `_apply_graph_execution_c1` + `resolve_graph_execution` — when product template sticky and `conversation_status` ∈ completed/complete/done → attach `graph_execution=continue` (`case_engagement.py` ~205–229; `ws/router.py` ~3742–3777). Node: `parseGraphExecution` / `isContinueInEnvelopeExecution` / `resolveExpertWorkPath(... continueInEnvelope)` → **free path**, not Hard schedule (`hard-graph-definition.ts` ~302–355; `session-runner.ts` ~184–206). Case intel re-injected each assign: RoE merge + `case_context` (thread + findings_summary + evidence_snippets). Tests: `tests/test_case_engagement.py::test_resolve_graph_execution_c1`; `node4/src/runtime/continue-chat-c1.test.ts`. |
| 5a | Dig deeper stays in Case Graph envelope (not free OMP new session) | **With glue** | Same conversation re-`task_assign` after complete → `continue` free-in-envelope under sticky template (not new Case). **Gaps:** no envelope field for focus / finding ids / stage subset; dig-deeper is free OMP tools + prompt, not Graph stage re-entry (see #82). User free-text “restart” may force **new** conversation (frontend `isRestartRequest` in `ConversationPage.tsx` ~2161–2173) — anti-pattern vs AGENTS.md structured intent. |
| 5b | Finding retest in-envelope (not free `engagement=retest` OMP) | **Blocked** | `POST /api/vulnerabilities/{id}/retest` (`vulnerabilities.py` `retest_vuln` ~434–515): always creates **new** `Conversation`, seeds free-text instruction, dispatches `_dispatch_retest_if_possible(..., engagement="retest")` — pack alias → free pentest, **no** `engagement_template` / `graph_execution`, Case attach is empty **new** conv only (not source Case RoE). UI list navigates to new `active_conversation_id` (`VulnerabilityPage.tsx`). Detail retest removed (deprecated). Matches #82. |
| 5c | Continue-chat with Case/Graph context; default no full Graph re-run | **Landable now** | Same as clause 4. Explicit `graph_execution=full|run|restart` still full Hard (`resolve_graph_execution` + Node path). Status sticky continue is server-side; UI need not send the field. |
| 6 | Internal new task_id / workspace OK; no hard-graph dir resume required v1 | **Landable now** | Each assign: new `task_id`; Node `taskDir = join(workspaceDir, task.taskId)` (`session-runner.ts` ~69–77). Hard stage dirs under that taskDir. Prior run artifacts are **not** required; continuity for operators is platform Case (`case_context` + ledger tools), not disk resume. Aligns with C1 law #6. |

---

## 3. Scenario 1–3 walk-through (as-built vs C1 gap)

### Scenario 1 — Dig deeper after findings (coverage / risk challenge)

| Step | As-built | C1 want | Gap |
|------|----------|---------|-----|
| Graph produces findings | Expert Graph books into platform ledger; messages + vulns on **same** conversation | Same | — |
| User challenges coverage in chat | Same `activeId` conversation; new `user_message` → new `task_assign` | Same Case | — |
| After prior Graph `completed` | `_apply_graph_execution_c1` → `graph_execution=continue`; Node free-in-envelope (sticky template + RoE + case_context findings) | Re-probe **in Graph envelope** | **Partial:** envelope = Case RoE + free tools, **not** Hard stage re-entry / stage subset |
| Focus named findings / surfaces | Free-text instruction only (or citizen prior-reverify note in `case_context.note`) | Structured focus fields (no NLP invent mode) | **Missing** product fields |
| Accidental full Graph | Explicit `full` or first-run (status not completed) | Explicit only | Explicit path OK; UI `isRestartRequest` can spawn **new Case** — product risk |

**Verdict S1:** Stay-in-Case is **landable**; dig-deeper **as Graph re-entry** needs glue (envelope fields + runner honor — map #81 construction after grill).

### Scenario 2 — Finding retest after fix

| Step | As-built | C1 want | Gap |
|------|----------|---------|-----|
| Operator hits 复测 | `retest_vuln` → **new** Conversation titled `复测: …` | Same Case conversation | **Hard break** |
| Dispatch | `engagement="retest"` free OMP; new task_id; attach case_context of **new** (empty-ish) conv | In-envelope Expert Graph re-entry / free-in-envelope under **source** Case | **Wrong shape** (#82) |
| Source link | `context.retest.source_conversation_id` stored; not used to merge source RoE/template | Source Case sticky RoE + findings | Pointer only |
| Status lifecycle | `to_fix → fixing` on start | Same + outcome wiring later | Start OK; outcome incomplete (out of C1 identity scope) |
| UI | List retest switches `active_conversation_id` away from source Case | Stay on Case | Breaks user Case mental model |

**Verdict S2:** **Blocked** for C1 product truth until retest API/UI stop creating a new session as the operator model. Implementation options are product-model grill territory (not decided here): re-dispatch on source conversation with structured fields vs attach retest as sub-thread of same Case without free OMP new session.

### Scenario 3 — Continue-chat process Q&A (no full Graph re-run)

| Step | As-built | C1 want | Gap |
|------|----------|---------|-----|
| Graph `task_complete` | Conversation → `completed` (or incomplete/blocked map); workers cleared | Case remains open | — |
| User asks “how did you conclude X?” | Same conversation message → task_assign with sticky template + **continue** | Same + context | **Matched** |
| Context available | `case_context` thread + findings_summary + evidence; citizen tools list vulns | Case intel | **Matched** (truncated thread limits apply — `DEFAULT_THREAD_LIMIT=40` etc. in `case_context.py`) |
| Full re-run avoided | `continueInEnvelope` forces free path even with target present | Default no full Graph | **Matched** (regression covered by `continue-chat-c1.test.ts`) |
| Switch to Default seat | `engagement=default` ledger assist; still same conversation | Agent session inside Case | **Matched** |

**Verdict S3:** **Landable now** for product law; residual polish (token budgets, UI “envelope mode” affordance) is optional, not identity-blocking.

---

## 4. Hard gaps ranked (what construction must change)

Ordered by C1 block severity (identity first, then envelope capability).

| Rank | Gap | Blocks | Construction direction (not implementing) |
|------|-----|--------|-------------------------------------------|
| **H1** | Product retest creates **new Conversation** + free `engagement=retest` | S2 / C1 §5 | Retest must re-enter **source Case** conversation (or explicitly model “Case = multi-conversation” — product grill). Drop free OMP new-session as truth. |
| **H2** | No structured dig-deeper / retest envelope (finding ids, re-entry mode, stage set) | S1–S2 Graph re-entry | Add structured fields on `task_assign` (and Case sticky if needed); Node honor modes; **no** NLP routing of free text (AGENTS.md). |
| **H3** | Stage / targeted Graph re-entry missing | S1–S2 full #68 modes | Runner always full sequence from stage 0; `initialHandoff` unused by product path (#82). Separate from Case identity but required for “Graph envelope re-probe” DoD. |
| **H4** | Frontend `isRestartRequest` NLP → force new conversation | Case stickiness myths | Structured restart / full re-run control; do not invent new Case from free-text “restart”. |
| **H5** | Retest does not merge **source** Case RoE / `engagement_template` / `graph_execution` | S2 even if conv fixed | `_dispatch_retest_if_possible` only attaches empty new-conv case_context; no `_merge_case_roe` from source; no C1 apply. |
| **H6** | Design chip / free-text [复测] as intent (design.md) | Product anti-pattern | Keep out of intent path (map #81). |
| **Soft** | continue = free OMP under sticky template, not a Graph “chat stage” | Semantic purity | Acceptable under C1 §3–4 + shipped `task-graph.md` C1 wording; not a Case-identity blocker. |
| **Soft** | New `taskDir` each burst | Disk continuity | Explicitly **allowed** by C1 §6. |

---

## 5. Minimal seam list (files + fields) — no implementation

### 5.1 Identity / Case (already core)

| Seam | Role |
|------|------|
| `platform/backend/app/models/conversation.py` | Case row identity |
| `platform/backend/app/api/conversations.py` | `/case` view/update; Case-shaped context keys |
| `platform/backend/app/services/case_engagement.py` | `engagement_template`, `allow_postex`, `resolve_graph_execution` |
| `platform/backend/app/services/case_context.py` | `case_context` payload: `conversation_id`, `thread`, `findings_summary`, `evidence_snippets`, `note` |
| `platform/backend/app/services/case_participants.py` | Multi-agent roster on `context.participants` |
| `platform/backend/app/services/conversation_state.py` | Status FSM including `completed → running` |
| `platform/backend/app/ws/router.py` | `_merge_case_roe_into_task_assign`, `_attach_case_context_to_task_assign`, `_apply_graph_execution_c1`, sticky expert / handoff |

### 5.2 Post-Graph continue (shipped C1 glue)

| Field / symbol | Where |
|---------------|--------|
| `graph_execution`: `"full" \| "continue"` (omit = first full when hard) | Platform out on `task_assign`; Node `TaskEnvelope.graphExecution` |
| `resolve_graph_execution(...)` | Platform policy |
| `parseGraphExecution` / `isContinueInEnvelopeExecution` / `resolveExpertWorkPath.continueInEnvelope` | Node4 |
| Conversation `status` terminal after Graph | Drives sticky continue |

### 5.3 Seams a construction cut would **add or rewrite** (grill-dependent)

| Seam | Why |
|------|-----|
| `platform/backend/app/api/vulnerabilities.py` `retest_vuln` / `_dispatch_retest_if_possible` | Stop new-Case free OMP; same-Case assign + structured mode |
| New structured fields (illustrative names only — product grill locks names): e.g. `graph_execution` already; plus `reentry_mode` / finding_ids / stage_ids as decided in #81 grills | Dig-deeper + retest without NLP |
| `node4` Hard runner honor stage subset / full re-run flag | #82 missing capabilities |
| `platform/frontend` VulnerabilityPage retest navigation | Stay on source Case |
| `platform/frontend` `isRestartRequest` | Must not redefine Case |
| Optional UI structured action for dig-deeper / retest (not design chip) | Operator scenarios D1 |

### 5.4 Explicit non-goals for this landability cut

- Resume same `workspace/{oldTaskId}/hard-graph/*` (C1 §6)
- Soft `prior_reverify` resurrection
- Default seat entering Expert Graph for retest
- Platform peer chat Agent

---

## 6. Myths to kill

| Myth | As-found truth |
|------|----------------|
| “Case is a separate table/entity from Conversation” | **v1 Case = Conversation** (`case_id` API returns conversation id). |
| “Retest stays in the Case” | **False** — always new Conversation + switches active chat. |
| “`engagement=retest` is Graph retest mode” | **False** — pack alias → free pentest (#82). |
| “After Graph, sticky template always re-fires full Hard stages” | **Was true risk; largely fixed** by C1 `graph_execution=continue` when status completed. Explicit full still re-runs. |
| “Continue-chat needs same Node pi session / same taskDir” | **False** — new task_id + case_context injection; law allows it. |
| “Multi-agent requires shared disk or handoff protocol” | **False** — Case messages + `case_context` + optional authorized handoff card; no shared taskDir required (`expert-offers.md`). |
| “Graph complete ends the collaboration session” | **False** — ends work-burst / may set conversation status completed; user messages continue on same conversation. |
| “Frontend restart keywords are product re-entry” | **Dangerous** — forces **new Case**; not structured Graph re-entry. |
| “Design chip [复测] is the product retest path” | **Must not be** — free-text template fill only. |
| “Landability requires rewriting Node4 Graph runner” | **No for Case identity** — runner rewrite only for stage/targeted re-entry productization (H3), orthogonal to Case 1:1. |

---

## 7. #82 reuse (retest / re-entry only)

Do not re-litigate full #82 inventory. Landability implications:

| #82 finding | C1 implication |
|-------------|----------------|
| Retest = new conv + free OMP | **Primary C1 block** for scenario 2 (this ticket H1) |
| Continue-chat partial at #82 time | **Improved on main** via `graph_execution=continue` — scenario 3 landable now |
| Stage / targeted re-entry missing | H2–H3 glue after product model grill |
| Full re-run = new assign with same template | Compatible with C1 if **same Case**; retest path is not that |
| Soft retired | Correct; not a retest answer |

---

## 8. Spec / decision anchors

| Doc / decision | Relevance |
|----------------|-----------|
| `docs/specs/expert-offers.md` Case (v1) | 1 conversation = 1 Case |
| `docs/specs/task-graph.md` L8–15, L49 | Expert Graph-only; C1 continue-chat; retest map #81 |
| `docs/specs/harness.md` | Free vs Expert Graph; Case evidence booking |
| `docs/prd.md` §4.1 | Shared session; participants; rediscover |
| `AGENTS.md` Intent rules | No NLP invent retest/engagement |
| Map #81 / #68 locks | In-envelope retest; continue without full re-run; structured fields only |
| ADR 0001 | Node4 unique product path |

---

## 9. Sources consulted

| Area | Paths |
|------|--------|
| Conversation / Case API | `platform/backend/app/models/conversation.py`, `api/conversations.py` |
| Case RoE / C1 policy | `services/case_engagement.py`, `tests/test_case_engagement.py` |
| Case context | `services/case_context.py`, `tests/test_case_context.py` |
| Multi-agent roster | `services/case_participants.py` |
| Status FSM | `services/conversation_state.py` |
| WS dispatch / C1 attach | `ws/router.py` (`_apply_graph_execution_c1`, `_merge_case_roe_*`, `_attach_case_context_*`, task_complete settle) |
| Vuln retest | `api/vulnerabilities.py` (`retest_vuln`, `_dispatch_retest_if_possible`) |
| Findings model | `models/vulnerability.py` |
| Frontend Case stickiness | `ConversationPage.tsx` (`isRestartRequest`, engagement template); `VulnerabilityPage.tsx` retest |
| Node envelope | `node4/src/types.ts`, `main.ts` `normalizeTask` |
| Work path / C1 | `hard-graph-definition.ts`, `session-runner.ts`, `continue-chat-c1.test.ts` |
| Specs | `docs/specs/expert-offers.md`, `task-graph.md`, `harness.md`, `docs/prd.md` |
| Prior research | `docs/wayfinder/retest-graph-reentry-seams.md` @ `b85f4a6` (branch `research/retest-graph-reentry-seams`) |

---

## 10. Grill handoff (#83) — architecture facts (not product decisions)

#83 can assume without re-guessing:

1. **Case identity is Conversation** — no second Case table to invent for v1.
2. **Continue-chat C1 is already wired** end-to-end for sticky product templates after completed status.
3. **The main Case-law contradiction in product code is vuln retest’s new conversation.**
4. **Graph re-entry modes** (stage/targeted/full) are still missing; full re-run ≈ same-Case new assign with `graph_execution=full` + sticky template.
5. **Internal workspace churn is fine**; do not require hard-graph directory resume for v1.
6. **Multi-agent Case share is `case_context` + roster**, not shared taskDir.

Open product-model questions remain on map #81 (naming dig-deeper fields; how much continue-chat UI glue; retest conversation identity). This research does **not** decide them.
