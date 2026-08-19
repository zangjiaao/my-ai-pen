# Spec: LLM stream liveness + fail-closed incomplete streams

**Status:** Implemented (product contract) — Runtime stream health + fail-closed incomplete/idle + diagnosis package; FE projects `llm_stalled`  
**Tracker:** [#353](https://github.com/zangjiaao/my-ai-pen/issues/353); idle-arm while siblings run: [#497](https://github.com/zangjiaao/my-ai-pen/issues/497)  
**Decision source:** Live diagnosis of Case `6eb54137-6b8e-47b5-9548-1d7baedbb69d` — thinking done → ~16 min silence at `llm_waiting` → terminal `模型调用失败：Stream ended without finish_reason`; operator could not distinguish hang vs work; post-hoc forensics could not prove tool-arg vs empty stream vs proxy (observability blind zone). Case `2c0d58aa-…` (#497): first of several parallel `tool_execution_end` armed idle abort while a Worker package was still running → Main `Request was aborted` when tools finally returned.

**Product path:** Node4 Graph × Pi + platform conversation UI (ADR 0001).  
**Amends (thin):**  
- `docs/specs/timeline-activity-liveness.md` / Spec [#305](https://github.com/zangjiaao/my-ai-pen/issues/305) — mid-task liveness after tools covers T1 empty thinking until tokens; **does not** cover long post-thinking gaps when the provider stream is still open but no projectable frames, nor fail-closed incomplete streams.  
- Spec [#350](https://github.com/zangjiaao/my-ai-pen/issues/350) (tool call lifecycle from tool-name known) — **adjacent, not this Spec.** #350 owns tool process chrome once a tool name is known. This Spec owns **LLM stream health** when no tool name is known / stream is unhealthy / stream ends without `finish_reason`.

**Does not amend:** Finding Store / book-path, Task Map history (#321), Worker audit isolation (#308), intent NLP ban (`AGENTS.md`), Default seat never-Graph.

---

## Problem Statement

Operators watching an active Case see the Agent finish a thinking block (or show only Status `llm_waiting` / “分析…规划下一步”) and then **nothing** for a long time. Conversation stays `running`. When failure finally appears, it is often a single terminal line such as **`模型调用失败：Stream ended without finish_reason`**—minutes after the useful timeline last moved.

From the operator’s view:

1. Silence after thinking does not say whether the model is still streaming, stalled, or already broken.  
2. Errors feel “delayed” even when the product is only waiting for the provider stream to end—there is no intermediate unhealthy state.  
3. Post-mortems cannot answer “was it large tool args, empty deltas, proxy half-open, or encrypted reasoning?” because **no durable stream diagnostics** exist between last progressive frame and terminal error.

Incident class: Case `6eb54137-…` (task `3917753b-…`): last progressive activity thinking **done** ~08:54Z; terminal error ~09:10Z; `events.jsonl` had no intermediate stream health records; usage counters stayed frozen at pre-gap values.

---

## Solution

1. Treat the **in-flight LLM provider stream** as a first-class **product process** during `llm_waiting` / model turn—not only thinking tokens and tool execution.  
2. **Runtime is source of truth** for stream health signals (chunk cadence, last activity, high-level chunk kind). Platform FE **projects** them; FE must not invent stall by free-text heuristics or fixed “maybe stuck” copy without Runtime frames.  
3. Emit **durable / Status-visible liveness** while a stream is open and no progressive thinking/text/tool frame has landed for a configured idle window (**stall**).  
4. **Fail-closed** incomplete streams: when the stream ends without a valid completion (`finish_reason` / equivalent success stop), surface the error **immediately on terminalization**—and optionally **abort earlier** on sustained zero-progress idle so operators are not left in a 10–20 minute black box.  
5. On every LLM-turn terminal failure, persist a **diagnosis package** (idle_ms, last_chunk_at, whether tool name was ever seen, finish_reason presence, provider message)—enough for next-incident triage without guessing.  
6. Keep **#350** as the path for tool-name-known chrome; do not use this Spec to dump tool argument bodies into the Main timeline.

### Product locks

| # | Lock |
|---|------|
| L1 | Runtime owns stream health; FE projects only Runtime-issued frames/fields. |
| L2 | No free-text / keyword “stuck detection” in platform code (`AGENTS.md`). |
| L3 | Stall signal is **in addition to** #305 T1 empty thinking—not a reseed of Spec #276 pending chrome. |
| L4 | Incomplete stream end (`without finish_reason` class) must produce an immediate user-visible failure path (same class as existing `LlmTurnError` → task failed). |
| L5 | Optional early abort on sustained idle is product-configured and disclosed via the same failure channel—not a silent kill. |
| L6 | Diagnosis package is required on LLM-turn terminal failure; must not include full tool arg bodies or secrets by default. |
| L7 | No inventing that large tool args caused a gap without stream diagnostics proving tool-name / arg progress. |
| L8 | Does not replace #350; if tool name becomes known, #350 chrome applies and stream stall may still apply if no further progress. |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **LLM stream** | One provider streaming completion for a model turn (SSE/chunk iterator). |
| **Stream liveness** | Evidence that the stream is making progress (chunks / activity timestamps). |
| **Stall** | Stream still open (or turn still `llm_waiting`) but no projectable progress for longer than the stall threshold. |
| **Incomplete stream** | Stream ends without a successful stop / `finish_reason` (e.g. `Stream ended without finish_reason`). |
| **Diagnosis package** | Structured fields attached to terminal LLM failure for operators and agents. |
| **Chunk kind (coarse)** | Runtime-classified activity: thinking / text / toolcall / empty_or_other—not full raw payload. |

---

## User Stories

1. As an operator, I want to know the Agent is still waiting on the model after thinking ends, so that silence is not ambiguous.  
2. As an operator, I want a stall signal when the model stream has gone idle without finishing, so that I do not stare at a frozen timeline for tens of minutes.  
3. As an operator, I want incomplete stream failures shown as soon as the Runtime terminalizes the turn, so that I am not left believing work is still progressing.  
4. As an operator, I want optional early fail when the stream is idle too long, so that Cases do not sit `running` indefinitely on a half-dead connection.  
5. As an operator, I want the failure message to keep the provider detail (e.g. without finish_reason), so that I can tell API stream issues from tool failures.  
6. As an operator, I want Status / phase language to stay consistent with the chat (llm_waiting vs stalled vs failed), so that panels do not contradict the timeline.  
7. As an operator, I want stall chrome not to re-open post-send “思考中…” pending, so that Spec #276 stays narrow.  
8. As an operator, I want #305 empty running thinking for tool→think gaps to keep working, so that normal mid-task wait is unchanged.  
9. As an operator, I want tool-name-known work to still get tool cards from #350, so that long arg formation is not only a stream-stall problem.  
10. As an operator, I want diagnosis fields when a turn fails, so that support/debug can see last activity time and whether a tool was ever named.  
11. As an operator, I do not want full tool argument dumps in chat, so that secrets and huge payloads stay out of the transcript.  
12. As an Expert Agent author, I want clear turn failure when the stream dies incomplete, so that I do not continue as if the turn succeeded.  
13. As a platform implementer, I want one Runtime stream-health owner, so that FE does not invent timers per card type.  
14. As a platform implementer, I want stall thresholds in configuration with conservative defaults, so that lab and product can tune without code forks.  
15. As a QA engineer, I want fixtures that inject chunk silence then incomplete end, so that stall + fail-closed cannot regress.  
16. As a QA engineer, I want fixtures that normal thinking/tool streams never emit false stall, so that healthy turns stay quiet.  
17. As a QA engineer, I want fixtures that diagnosis package is present on LlmTurnError-class failures, so that blind zones do not return.  
18. As a reviewer, I want living-doc cross-links to #305 and #350, so that three liveness Specs stay non-overlapping.  
19. As an operator, I want multi-tab reload to show durable failure and last known phase, so that refresh does not hide the outcome.  
20. As an operator, I want Graph and Free paths to share the same stream-health rules, so that Expert work modes feel consistent.  
21. As a Node Runtime owner, I want events/task diagnostics to record stream heartbeats even when UI progressive frames do not fire, so that disk forensics match TLS reality.  
22. As an operator, I want cancel/interrupt to remain available during stall, so that I can stop a bad stream without waiting for provider end.  
23. As a developer, I want no hardcoded fake “模型还在想…” catalogs, so that AGENTS.md harness rules hold.  
24. As a developer, I want chunk-kind classification to be coarse and fail-closed to `empty_or_other`, so that we do not over-parse provider quirks.  
25. As an operator, I want token/request metering to remain honest (#323 independence)—stream stall must not reset Case ledgers.  
26. As a QA engineer, I want pure transition tests over live LLM, so that CI does not need a real provider.  
27. As an operator, I want historical Cases that failed pre-Spec to still render old messages, so that migration is non-breaking.  
28. As a platform implementer, I want Worker/subagent streams either in scope with the same rules or explicitly out of scope for v1, so that Main Case chrome is not confused.  
29. As a reviewer, I want Out of Scope to exclude dumping raw SSE into the Main transcript, so that privacy and volume stay bounded.  
30. As an operator, I want the product to never claim “large tool args” as the cause without diagnostics that show tool-name/arg progress, so that narratives stay evidence-based.

---

## Implementation Decisions

1. **Primary seam (S1) — LLM stream lifecycle:** Session/task-scoped stream health for the Main model turn: open → activity → stall → terminal (success | incomplete | aborted). Prefer extending the existing observability / agent-event bridge (`tool_execution_end` → `llm_waiting` path) rather than a second parallel kernel. **#497:** `tool_execution_end` opens health / emits `llm_waiting` only when in-flight tool count hits zero. Overlapping tools (e.g. fast `http` + long `subagent`) keep health **closed** (`tool_running`); stall and idle abort must not arm until the last sibling finishes. Sequential single-tool turns unchanged.  
2. **Secondary seam (S2) — Diagnosis package on terminal LLM failure:** On `LlmTurnError` / incomplete-stream class failures, attach structured fields (see sketch) to the same user-visible failure path and to task/events diagnostics.  
3. **Tertiary seam (S3) — UI projection:** Status/timeline project Runtime stall + failed states only; no FE-only “N seconds then guess stuck.”  
4. **Stall threshold:** Default **45s** idle after last stream activity (`NODE4_LLM_STALL_MS`). Stall emits Runtime `agent_phase=llm_stalled` + `stream_health` snapshot + panel detail; it does not invent thinking prose or reseed #276 pending.  
5. **Early abort (recommended v1):** Default **180s** idle (`NODE4_LLM_IDLE_ABORT_MS`; set `0` to disable). Runtime aborts the provider stream and fails the turn with `stream idle timeout` / diagnosis `idle_timeout`—same `LlmTurnError` → `task_error` channel as incomplete finish_reason.  
6. **Incomplete stream:** When the provider iterator ends without success stop / finish_reason, map to existing user-facing LLM error formatting immediately; do not wait for unrelated retries to “accumulate.”  
7. **Coarse chunk kinds only:** thinking / text / toolcall / empty_or_other for diagnostics—not full SSE replay in Case chat.  
8. **Relation to #305:** Keep T1 empty running thinking for tool→think. After thinking is **done**, if the stream continues without new projectable frames, stream-stall owns liveness—not a second pending reseed.  
9. **Relation to #350:** When tool name becomes known, #350 running tool card is required; stream health may still track arg progress via coarse toolcall activity without dumping args.  
10. **Persistence:** Heartbeats/diagnostics should land in task events (or equivalent) even when progressive chat frames are sparse, so Case forensics match runtime reality.  
11. **Metering:** Stream stall/abort must not reset Case token/work-seconds ledger (#323).  
12. **Scope default:** Main Free + Graph parent turns in v1; subagent/Worker streams follow the same rules only if already sharing the same observability bridge—otherwise document as follow-up.  
13. **No NLP** for stall intent; no hardcoded vulnerability/tool catalogs as stall copy.

### Lifecycle sketch (decision-rich)

```
stream: closed | open | stalled | terminal

on provider stream open (turn_start, or last in-flight tool_execution_end):
  health = open; last_activity = now

on tool_execution_start:
  health = closed; in_flight += 1

on tool_execution_end:
  in_flight = max(0, in_flight - 1)
  if in_flight == 0: open as provider stream wait
  else: stay closed (siblings still executing)

on provider chunk (any):
  last_activity = now
  if health == stalled: health = open  // resume
  record coarse kind counters

on idle > stall_threshold while turn llm_waiting:
  health = stalled
  emit Runtime stall signal (Status + diagnostic; not pending reseed)

on idle > abort_threshold (if enabled):
  abort provider stream
  terminal = fail("stream idle timeout" class)
  emit diagnosis package

on stream end:
  if success stop / finish_reason ok: terminal = success
  else: terminal = fail(incomplete stream class) immediately
  emit diagnosis package on fail
```

### Diagnosis package (minimum fields)

- `stream_terminal_class`: incomplete_finish | idle_timeout | provider_error | other  
- `provider_message` (short, existing formatLlmError style)  
- `last_activity_at` / `idle_ms`  
- `chunk_count` / coarse kind counts  
- `tool_name_seen` (boolean) + optional tool name if known  
- `finish_reason_present` (boolean)  
- No full tool args; no API keys.

---

## Testing Decisions

**Good tests** assert external behavior at S1–S3 only: stall signal appears after injected silence; healthy short streams never stall; incomplete end produces immediate failure + diagnosis fields; early abort terminates turn; FE shows Runtime stall without inventing timers—not internal helper names.

| Seam | Example external behaviors |
|------|----------------------------|
| **S1** | After last activity + stall threshold → stall signal; activity resumes → stall clears; healthy multi-chunk turn → no stall. Overlapping tools: first end does not stall/abort; last end opens wait. |
| **S2** | Incomplete stream end → user-visible LLM failure + diagnosis package fields present; idle abort → same channel with idle class. |
| **S3** | Projection uses Runtime fields; no FE-only stall without Runtime frame. |

**Prior art:** Spec #305 platform-observability mid-task T1 tests; Spec #276 stream identity / pending; `llm-turn-error` extract/format tests; hard-graph LlmTurnError settlement tests.

**Fixtures:** Synthetic provider stream (chunks then silence; end without finish_reason); pure transition tests preferred over live LLM.

### Test seams (normative)

| ID | Seam | Role |
|----|------|------|
| **S1** | LLM stream lifecycle (open / activity / stall / terminal) | Primary |
| **S2** | Terminal failure + diagnosis package | Secondary |
| **S3** | Status/timeline projection of stall/fail | Tertiary |

Ideal: implementers hang behavior on these three seams only—no fourth “maybe stuck” timer kernel in the FE.

---

## Out of Scope

- Spec #350 tool-name-known running card implementation (separate Spec).  
- Dumping full tool argument bodies or raw SSE into Main chat.  
- Changing Finding Store, book-path L0, Task Map history (#321).  
- Reseeding Spec #276 post-send pending on tool/stream gaps.  
- Intent detection via keyword/regex on user or model text.  
- Guaranteeing provider never drops finish_reason (cannot fix third-party).  
- Full distributed tracing product (OpenTelemetry platform) as a delivery requirement.  
- Redesigning Worker audit dialog (#308) beyond optional shared stream rules.  
- Mandatory auto-retry storms that hide incomplete streams from the operator.  
- Hardcoded fake progress narration.

---

## Further Notes

- **Why not only #305:** T1 covers tool→first thinking tokens; Case `6eb54137-…` failed **after** thinking was already **done**, with no further progressive frames.  
- **Why not only #350:** Terminal error was incomplete stream; forensics could not prove tool-name-known arg streaming. #350 is necessary but not sufficient.  
- **Why fail-closed idle:** Waiting solely for provider end produced ~16 minutes of `running` with no operator signal; product should not require operators to guess.  
- **Evidence discipline:** Do not document “large args” as root cause without S1/S2 diagnostics that show toolcall activity.  
- **Living doc:** keep this file in sync when shipping; link from `docs/README.md`.  
- **Suggested issue title:** Spec: LLM stream liveness + fail-closed incomplete streams (Main).
