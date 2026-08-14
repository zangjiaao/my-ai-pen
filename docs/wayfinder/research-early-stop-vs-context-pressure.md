# Research: Early natural-stop vs context pressure

**Date:** 2026-08-14  
**Ticket:** GitHub **#464** · Map **#461**  
**Question:** Is the long-standing **“model finishes the task too early”** behavior caused by **context-window pressure**, or by something else?  
**Sources:** Node4 code + living specs + frozen `benchmarks/` notes. Industry/academic primaries cited only for the distinct rot hypothesis. **No product compact decision.**

---

## Executive answer

| Required | Finding |
|----------|---------|
| **(a) What the harness does** | Product outer continue / premature / empty / goal inject are all **0**. After the model stops tool-calling, the work burst **settles**. Telemetry remaps the first such stop to `natural_stop` (no tools this segment) or `natural_stop_after_tools` (tools then stop). |
| **(b) What overflow would look like** | A full window is **not** remapped to a clean natural stop. Soft provider `stopReason=error` and known stream failures become `LlmTurnError` → `task_error`. Other provider throws (typical context-length HTTP text) also become `task_error`, not `task_complete`. |
| **(c) Lab artifact overflow?** | **No.** Frozen Juice / DVWA / pentest-lab notes record `natural_stop_after_tools`, Graph completed/blocked, or premature-as-process-judgment. No `context_length` / overflow / “prompt too long” strings. |
| **(d) Remaining unproven rot hypothesis** | Industry primaries show **retrieval/accuracy** degrade as input grows *before* hard overflow. They do **not** measure agents **wrapping up or skipping remaining work**. First-party comments attribute early settle to **todos marked done / map-complete ≠ recon**, not a window threshold. That wrap-up-from-rot causal story is **unproven**. |

**Separation (not a Spec):** *early natural-stop* = model emits no more tools and the product harness accepts that as settle. *Hard overflow* = provider/stream failure surfaced as error. *Context rot* = quality drop while the call still succeeds. The three are different mechanisms.

---

## 1. Product settle path — a “done too early” burst

### 1.1 Defaults are all zero

`resolveOuterContinueBudgets` (`node4/src/runtime/loop-policy.ts`):

| Field | Product default | Env override (lab) |
|-------|-----------------|--------------------|
| `maxContinues` | **0** (`NODE4_MAX_CONTINUES` / `_DEFAULT` for ledger-assist) | positive int |
| `maxEmptyStopStreak` | **0** (`NODE4_MAX_EMPTY_STOPS`) | positive int |
| `maxPrematureStops` | **0** (`NODE4_MAX_PREMATURE_STOPS`) | positive int |
| `maxGoalContinues` | **0** (unset or `0`) | `unlimited` or positive int |

Smoke contract (`node4/src/node4-smoke.ts`): empty env → all four 0; first empty stop does **not** continue and normalizes to `natural_stop`; tools-then-stop does **not** outer-continue and normalizes to `natural_stop_after_tools`.

Living spec (`docs/specs/harness.md` §1 / §3 / §5): **Product default: no outer empty/premature/goal inject** — settle when the model naturally stops after in-loop tool use. No agent finish tool. No session wall.

`session-runner.ts` wires those budgets and comments: *Outer continues: product default OFF (settle on natural stop).* Discovery stays in-loop (pi agent-loop). `NODE4_MAIN_MAX_TURNS` is still parsed in `node4/src/config.ts` but **not read** by the runner (leftover; not a live wall).

### 1.2 What “done too early” looks like in code

Free-path burst (`node4/src/runtime/session-runner.ts`):

1. `session.prompt(...)` returns when the **model stops emitting tools** (or abort). That return is treated as a candidate natural stop — not as overflow.
2. `promptAndAssert` then runs `extractLlmTurnError`. Soft `stopReason=error` **throws** `LlmTurnError` (no settle).
3. If the turn was clean, `evaluateContinueAfterSegment` → `shouldContinueAfterNaturalStop`.
4. With all budgets 0 and goal off, the **first** check is `continueCount >= maxContinues` → `{ continue: false, reason: "max_continues" }` — **before** empty / booking-gap / premature / goal branches.
5. `normalizeProductStopReason` (only when `continueCount === 0`) remaps `max_continues` / `max_empty_stops` to:
   - `toolsInLastSegment > 0` → **`natural_stop_after_tools`**
   - else → **`natural_stop`**
6. Loop breaks. `task_complete` carries that `stop_reason`. `resolveHarnessTerminalStatus`: booked findings > 0 and not aborted → `completed`; else `incomplete`. Open todos **do not** block settlement (`docs/specs/harness.md` §7; `docs/specs/free-tasks-continue-integrity.md` L5).

So a product “finished too early” burst is: **in-loop tools (or none) → model end_turn/stop → budgets 0 → remapped natural stop → `task_complete`.** The harness does **not** ask whether the window is full.

Graph stages (`hard-graph-stage-executor.ts`) create a **new** `createBoundNode4Session` per stage (fresh Agent / transcript). Same-stage park continue is a different seam (map #461 chart-time note); it is not the Free settle path above.

### 1.3 Distinct wrap-up path (not overflow)

Optional goal `token_budget` (`node4/src/stores/goal.ts`, `session-runner.ts`): when tokens used hit the **goal** budget, status flips to `budget-limited` and a one-shot **wrap-up steer** is injected. Product default **does not** outer-inject `goal_continuation` (`maxGoalContinues === 0`). This is an explicit lab/goal budget, **not** `LLM_CONTEXT_WINDOW`.

---

## 2. What overflow would look like (if it happened)

### 2.1 No window-threshold settle

| Mechanism | What the code actually does |
|-----------|-----------------------------|
| `LLM_CONTEXT_WINDOW` | Model **metadata** only when synthesizing an unknown model (`run-node4-agent.ts` `resolveNode4Model`). Default 128_000. Not a settle trigger. |
| `transformContext` / compaction | **Not** passed to `new Agent({...})` in `runNode4Agent`. ADR 0001 *allows* `transformContext` as a Runtime API; product Runtime does not use it. |
| Per-tool output | Soft truncate ~48k chars, archive under `taskDir/tool-output/` (`docs/specs/harness.md` C3; `tool-result-wire.ts`). Caps **one tool result**, not the session window. |
| Window occupancy → `natural_stop` | **No such branch** in `loop-policy.ts` / `session-runner.ts` / `llm-turn-error.ts`. |

### 2.2 Error channels (not clean stop)

`llm-turn-error.ts` file comment: *surface to UI + `task_error` — never silent `natural_stop` / completed.*

| Incoming signal | Product path |
|-----------------|--------------|
| Assistant `stopReason` / `stop_reason` **`error`** | `extractLlmTurnError` → `formatLlmErrorForUser` → `surfaceLlmTurnFailure` → `LlmTurnError`. `main.ts` emits `task_error` with `stop_reason: "llm_error"`. |
| String `errorMessage` with a **non**-success stop | Same extract → `LlmTurnError`. |
| Success-looking stops (`end_turn`, `tool_use`, `stop`, **`length`**, **`max_tokens`**, `content_filter`, …) | `SUCCESS_LOOKING_STOPS` — extract returns **null**. A string error field on those stops is **ignored**. `length` / `max_tokens` here are treated as **successful-looking output finishes**, not as window-full. |
| `session.prompt` **throw** | `mapPromptFailureToLlmTurnError` maps only idle-abort, existing `LlmTurnError`, and **incomplete-stream** phrases (`without finish_reason` / `no finish_reason` / `missing finish_reason` in `llm-stream-health.ts`). Other throws (including typical provider *context_length_exceeded* / *prompt is too long* text) are **rethrown unchanged**. `main.ts` then `task_error` with `stop_reason: "error"` and the raw message. |
| Idle abort | `idleTimeoutLlmTurnError` → same `task_error` channel. |
| User / platform cancel | `stopReason = "aborted"` (not overflow). |

`classifyStreamProviderMessage` has classes `incomplete_finish` / `idle_timeout` / `aborted` / `provider_error` / `other`. **No** `context_length` class. Provider overflow text that does not match those phrases is `other` if it ever reached stream diagnosis; a thrown HTTP error never becomes `natural_stop`.

Hard Graph uses the same extract / `surfaceLlmTurnFailure` / rethrow contract (`hard-graph-stage-executor.ts`, `hard-graph-runner.ts`): `LlmTurnError` closes the stage and does **not** emit `task_complete`. Tests: `hard-graph-task.test.ts`, `hard-graph-runner.test.ts`.

### 2.3 Is there any path that treats a full window as a clean natural stop?

**In Node4 product code: no.** Nothing inspects occupancy and then settles. Overflow, if the provider reports it, is an **error** (typed `llm_error` or generic `error`).

Caveats (observed, not invented as product policy):

- If the **provider** returned a **successful-looking** stop (`end_turn` / `stop` / `length`) with wrap-up text and **no** `stopReason=error`, the harness would treat that as a normal natural stop. That would be **provider success**, not “window full → we remap to natural_stop.”
- `length` / `max_tokens` in `SUCCESS_LOOKING_STOPS` are **output** finish reasons. A provider that reused those strings for *input* overflow **and** attached only a string `errorMessage` would **not** trip extract (error field ignored on success-looking stops). No first-party test or bench note shows that happening.

---

## 3. Lab recovery exists because agents stop after tools / todos

`shouldContinueAfterNaturalStop` comments (`loop-policy.ts`):

> Lab evidence: agents often mark all todos done before finishing recon surfaces.  
> Gating premature on openWork caused early `natural_stop` after the first free push.

Premature continues (when `NODE4_MAX_PREMATURE_STOPS` > 0) are **not** gated on open todos (*map-complete ≠ surface complete*). Inject text (`prematureStopContinuePrompt` / `discoveryBreadthReminder`) steers another dense shell burst and says completing the todo map is **not** finishing discovery.

Empty-stop continue (`empty_stop_continue`) exists for **tools == 0** then stop — again a model behavior, not a window threshold.

`docs/specs/harness.md` §5: outer premature is **lab-only**. Product breadth is prompt/skill-steered **inside the first natural tool loop**.

Pack language (`experts/pentest/work.md`): do not stop solely because “enough findings”; todo map complete ≠ coverage complete; disclose remaining NEW untested before wrap.

None of these recovery reasons mention token occupancy, `LLM_CONTEXT_WINDOW`, or provider overflow.

---

## 4. Context rot — distinct hypothesis, wrap-up unproven

**Definition used here:** quality / attention degrades as **input length grows while the API call still succeeds**, *before* hard overflow. Separate from “window full → API error.”

### 4.1 Primary industry / academic (what they measure)

| Source | What it measures | What it does **not** measure |
|--------|------------------|------------------------------|
| Hong, Troynikov, Huber — *Context Rot: How Increasing Input Tokens Impacts LLM Performance* (Chroma technical report, 2025-07-14) — [trychroma.com/research/context-rot](https://www.trychroma.com/research/context-rot) | 18 models; NIAH variants (lexical vs semantic, distractors, haystack structure); LongMemEval conversational QA; repeated-words replication. **Task complexity held constant**; performance degrades as input length grows, including well below advertised maxima. Mentions agent/summarization apps as *more complex in practice*. | Agent **declaring a multi-step job done** / skipping remaining tools or surfaces as context grows. |
| Liu et al. — *Lost in the Middle: How Language Models Use Long Contexts* (2023) — [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) | Multi-document QA and key-value retrieval vs **needle position** (U-shaped use of context). | Agent wrap-up / early stop of a tool loop. |

No first-party experiment in this repo measures wrap-up rate vs transcript tokens. The phrase “context rot” appears in `docs/wayfinder/research-skill-load-industry.md` only as a casual industry-hygiene remark (load bodies, rely on rot/compaction) — **not** a lab result.

### 4.2 First-party causal language (different story)

`loop-policy.ts` + `harness.md` + `experts/pentest/CHANGELOG.md` explain early settle as: **agents mark todos done / treat map-complete as engagement-complete**, then emit no tools. Lab premature was added (and later defaulted **off**) for that. That is **not** a claim that a window threshold fired.

### 4.3 Unproven remainder

It remains **possible** that, on a long Free parked Session, growing context makes the model more likely to write a wrap-up and stop tool-calling **without** overflowing. That is **not** established by Chroma/Liu (wrong dependent variable) and **not** established by Node4 benches (no occupancy series, no overflow errors). Treat it as an **open hypothesis**, not as the cause of historical `natural_stop_after_tools`.

---

## 5. Historical runs (`benchmarks/` — what is written)

Repo-wide search under `benchmarks/` for `context_length`, `context length`, `prompt is too long`, `maximum context`, `token limit`, `window full`, `overflow` (as LLM error): **no matches**.

### 5.1 pentest-lab 1.1.1 (Juice / MinIO / Redis)

`run-summaries-*.json` — all `terminalStatus: completed`, `stopReason: natural_stop_after_tools`:

| File | continueCount | bookedFindings | requests | input_tokens (cumulative) |
|------|---------------|----------------|----------|---------------------------|
| `run-summaries-juice.json` | 1 | 9 | 47 | 83_783 |
| `run-summaries-redis.json` | 1 | 2 | 23 | 26_662 |
| `run-summaries-minio.json` | 2 | 1 | 31 | 239_061 |
| `run-summaries-minio-s.json` | 1 | 2 | 39 | 158_156 |

`input_tokens` / `total_tokens` in these files are **sums across requests** (`node4/src/runtime/llm-usage.ts` `recordAssistantMessage` adds per assistant usage). They are **not** a single-window occupancy. `continueCount` ≥ 1 means **lab outer recovery was on** for those runs; they still ended `natural_stop_after_tools` after one or two injects — consistent with “model stopped after tools,” not with `task_error`.

`LAB-NOTES.md`: methodology / nuclei PATH / duplicate booking. **No** overflow or context-length language.

Instructions (`instructions/juice.txt`, `dvwa-omp.txt`): *prefer another dense act burst over early stop after easy wins* — process steering, not a recorded overflow event.

### 5.2 Juice discovery dual-arm

| Stamp / arm | Written terminal | Notes (as written) |
|-------------|------------------|--------------------|
| `20260723T190830Z/soft` | `completed` / **`natural_stop_after_tools`**, 6 booked | Scorecard SP8 *Premature stop?* → **unclear** (*density not fully stressed*). SP3 *natural stop may leave more surface*. **No** overflow. |
| `20260723T190830Z/hard` | `blocked` / `hard_graph_blocked`, **`bookedFindings`: 0** | `blockSummary`: *stage init: missing or invalid result.json* — **not** overflow; **not** 0-booked-from-window. |
| `20260723T200717Z/hard` | `completed` / `hard_graph_completed`, 8 booked | Stage summaries about remaining candidates needing more HTTP — **not** context errors. |

Scorecard template (`benchmarks/juice-discovery/scorecard-template.md`): process rows call out **premature stop** and single-location testing as a **scoring dimension**. That is a human judgment rubric, not a recorded provider overflow.

### 5.3 Hard vs Node5 (Juice / DVWA)

| Stamp | Written | Premature / overflow language |
|-------|---------|-------------------------------|
| `20260724T003348Z/juice` Hard | `hard_graph_completed`, 18 booked, full stage set | Scorecard **HP9 Premature stop: N**. No overflow. |
| `20260724T021339Z/dvwa` Hard | `hard_graph_completed`, 18 booked, all stages passed | Prior stamp `20260724T020525Z` **blocked@surface** (value-shaped surfaces) — process/gate, not window. |
| Instructions in those trees | same “over early stop after a few easy wins” line | Prompt hygiene. |

The only `"bookedFindings": 0` JSON hit in `benchmarks/` is the **init-blocked** Juice hard arm above.

### 5.4 Absence

No frozen scorecard, `meta.json`, run-summary, or `LAB-NOTES` records `LlmTurnError`, `stop_reason: llm_error`, `stopReason=error`, or provider context-length text as the terminal reason. Historical “early finish” language is **`natural_stop_after_tools`**, **premature** as a process score, or Graph **blocked** on structure/handoff.

---

## Source index

| Source | Role |
|--------|------|
| `node4/src/runtime/loop-policy.ts` | Budgets default 0; `natural_stop` / `natural_stop_after_tools` remap; premature comments (todos / map-complete) |
| `node4/src/runtime/session-runner.ts` | Product settle loop; `promptAndAssert`; `task_complete` + `stop_reason` |
| `node4/src/runtime/llm-turn-error.ts` | Soft `stopReason=error`; never silent natural_stop |
| `node4/src/runtime/llm-turn-surface.ts` | `mapPromptFailureToLlmTurnError` (idle / incomplete / typed only) |
| `node4/src/runtime/llm-stream-health.ts` | Incomplete/idle/abort phrases — no context-length class |
| `node4/src/runtime/run-node4-agent.ts` | `LLM_CONTEXT_WINDOW` metadata; `Agent` without `transformContext` |
| `node4/src/main.ts` | `LlmTurnError` → `task_error` / `llm_error`; other throws → `task_error` / `error` |
| `node4/src/node4-smoke.ts` | Product-off + lab-on budget contracts |
| `docs/specs/harness.md` | Product outer inject OFF; no finish tool; premature lab-only |
| `docs/specs/free-tasks-continue-integrity.md` | Open todos do not hard-block settle |
| `docs/adr/0001-graph-x-pi-product-path.md` | `transformContext` allowed, not required / not wired |
| `experts/pentest/work.md` | In-loop density; map ≠ coverage |
| `benchmarks/pentest-lab-1.1.1/*` | `natural_stop_after_tools` summaries; no overflow |
| `benchmarks/juice-discovery/**` | Soft natural_stop; hard blocked@init / completed; SP8 premature unclear |
| `benchmarks/hard-vs-node5/**` | Graph completed; HP9 premature N; blocked@surface is a gate |
| Hong et al. 2025 (Chroma) | Primary for **accuracy vs length** (not wrap-up) |
| Liu et al. 2023 (Lost in the Middle) | Primary for **position** (not wrap-up) |

---

*Living research note for map #461. Not product authority; does not change `docs/specs/harness.md` and does not choose a compact family.*
