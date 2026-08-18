# Spec: Agent Runtime context-window management

**Status:** Living — shipped (Node4 `transformContext`: persist pass then checkpoint shrink).  
**Tracker:** Map [#461](https://github.com/zangjiaao/my-ai-pen/issues/461) · draft [#468](https://github.com/zangjiaao/my-ai-pen/issues/468)  
**Decision source:** Map #461 research [#462](https://github.com/zangjiaao/my-ai-pen/issues/462) / [#463](https://github.com/zangjiaao/my-ai-pen/issues/463) / [#464](https://github.com/zangjiaao/my-ai-pen/issues/464); family [#465](https://github.com/zangjiaao/my-ai-pen/issues/465); Store hygiene [#467](https://github.com/zangjiaao/my-ai-pen/issues/467); Intel hang [#459](https://github.com/zangjiaao/my-ai-pen/issues/459) + lifecycle [#466](https://github.com/zangjiaao/my-ai-pen/issues/466).

**Product path:** Node4 Graph × Pi + platform conversation UI (ADR 0001).  
**Agent Runtime seam:** `runNode4Agent` / `Agent` + optional `transformContext`. **Not** pi-coding-agent. **Not** `AgentHarness` as the product loop.

**Amends (thin):**  
- `docs/specs/harness.md` — long Free parked / same-stage Graph runs must shrink the **next model view**; natural-stop remains the settle law (this Spec does not re-enable outer continue).  
- `docs/specs/session-owns-runtime.md` / Spec [#354](https://github.com/zangjiaao/my-ai-pen/issues/354) — compact is **not** Session Reset (Reset still wipes Agent, keeps Todo).  
- `docs/specs/task-graph.md` — Graph **stage switch** already drops the prior-stage transcript (family D). This Spec adds mid-run shrink for **same-stage park** and **Free park**.

**Adjacent (do not merge):**  
- Owner ledger Intel Spec (map [#459](https://github.com/zangjiaao/my-ai-pen/issues/459)) — hang point Host/Service; lifecycle [#466](https://github.com/zangjiaao/my-ai-pen/issues/466). This Spec only **consumes** living (`active`) intel in the checkpoint.  
- Spec [#353](https://github.com/zangjiaao/my-ai-pen/issues/353) — stream stall / incomplete finish_reason. Overflow here is **context occupancy**, not stream silence.  
- Spec [#455](https://github.com/zangjiaao/my-ai-pen/issues/455) — continue turn text stays the operator utterance.

**Does not amend:** Finding book-path L0, intent NLP ban, Default seat never-Graph, outer-continue product-off (`NODE4_MAX_*` = 0).

---

## Problem

A long **Participant Session** (Free parked continue, or Graph **same-stage** park) keeps one pi `Agent` and grows `Agent.state.messages` without bound. Per-tool output is capped (~48k chars) and archived, but **N** truncated results still fill the window.

Today:

1. There is **no** occupancy shrink (`transformContext` unset; `LLM_CONTEXT_WINDOW` is unused as a threshold on builtin models).  
2. True overflow surfaces as generic `LlmTurnError` / `task_error`, not a clean `natural_stop`.  
3. Session Reset would drop the Agent; that is the wrong product answer for “window filling.”  
4. Expert Graph **reduces** pressure by minting a new Agent per stage; it does **not** prevent overflow **inside** a long stage.

Early “done” (`natural_stop` / `natural_stop_after_tools`) is a **different** failure (product outer continue is off). It is not occupancy.

---

## Solution

Treat shrink as a **checkpoint**, not a coding-agent chat-summary:

- **Durable step results** live in Product / Case Store (Finding, Surface, process fact) and forthcoming **living Intel** on Host/Service.  
- After shrink, the **next model view** only needs: **plan progress + current slice + thin Store indexes**.  
- Tool **process** in the Runtime transcript is disposable.  
- Platform **UI chat** (already projected thinking / text / tools) is **not** rewritten.

Family (locked): **A cut** (drop old process at a threshold) + **C rehydrate** (Store indexes) + **D** (Graph stage switch and package workers already use a fresh Agent).

A fat LLM `generateSummary` of the transcript is **optional and weak**. Default checkpoint text is one pointer line (“细节以 Store / 归档为准”), not a second Goal/Progress essay. pi-agent-core `shouldCompact` / `estimateContextTokens` **may** be used as helpers. `AgentHarness.compact()` and JSONL session trees **must not** become product Runtime.

---

## 1. Paths

| Path | Occupancy policy |
|------|------------------|
| **Free parked continue** | Mid-run shrink on the **same** Agent (this Spec). |
| **Graph same-stage park continue** | Same as Free (same growing Agent). |
| **Graph stage switch** | Already D: `createBoundNode4Session`; prior **transcript dies**; continuity is Product state / handoff. **Keep.** |
| **Package worker** | Already D: own Agent / window; return **structured** outcomes. Main **must not** keep the child transcript. |

Default seat / ledger-assist turns are in scope only if they reuse a growing parked Agent. Chat-only greetings are unlikely to hit the threshold.

---

## 2. Occupancy knobs (Node env, not Case UI)

| Knob | Default | Source |
|------|---------|--------|
| **Window** | Catalog `Model.contextWindow` | `getBuiltinModel`. **Unknown** model only: `LLM_CONTEXT_WINDOW` (default `128000`, min 1024). |
| **Trigger** | **80%** of that window | `NODE4_COMPACT_THRESHOLD` — fraction `0.50`–`0.95` (or percent `50`–`95`; Spec implementer picks one parse, clamp, disclose). |
| **Keep-tail** | Current **Todo slice** | Not env-tuned. Slice = messages since the current `in_progress` item was started (that **operator** user turn + following assistant/tool). If no `in_progress`, keep the last operator user turn only. Harness messages (`role=harness`: persist-pass, checkpoint, outer continue) are not operator turns. |
| **Reserve** | Implied by 80% | Equivalent spirit to coding-agent `window - reserveTokens`; product default is the ratio, not a 16k constant. |

Not a Case-user slider. Wrong window (env larger than the real model) must not be “fixed” by guessing; overflow still fail-closes (section 4).

Thinking / reasoning tokens **count** toward occupancy when the provider reports them on the last assistant usage (same as other input).

---

## 3. Model view after shrink

Send to the provider:

```text
system (unchanged layers)
+ checkpoint pointer (one short line)
+ rehydrate:
    Todo / TaskMap (current)
    Surface coverage summary (thin)
    Findings board ≤20 lines
    Process-fact index ≤ ~40 (existing cap)
    Living Intel (status=active) ≤50 lines (this-Case + login first; see owner-intel)
    Goal / hypothesis index if already injected today
+ keep-tail: current Todo slice (raw Agent messages)
```

Do **not** inject `falsified` / `expired` / `superseded` / `archived` Intel. The **lesson** of a dead end is a **new `active`** row (e.g. “admin:admin invalid as of …”), per [#466](https://github.com/zangjiaao/my-ai-pen/issues/466).

`transformContext` is the default seam: it changes the **request-time** `AgentMessage[]` and **must not** be required to mutate stored `agent.state.messages` or platform chat rows. Idle rewrite of `state.messages` is allowed only if UI chat remains the platform projection (not the Runtime transcript).

---

## 4. Fail-closed

| Event | Product |
|-------|---------|
| Occupancy ≥ threshold | **Persist pass then shrink** (below). Not shrink-only. |
| Shrink succeeds | Continue the turn / continue park attach. |
| Shrink fails | **One** retry; then `LlmTurnError` / `task_error` with an occupancy diagnosis (not `natural_stop`). |
| Provider still rejects (true overflow) | Same `task_error` channel as today; diagnosis should say occupancy / context-length when the provider text does. |
| User interrupt | Existing abort ≠ package-fail; park remains [#354](https://github.com/zangjiaao/my-ai-pen/issues/354). Compact is not interrupt. |
| Session Reset | Existing wipe-Agent / keep-Todo. Compact is not Reset. |

Process death: park is memory-only. Reseed is mode-correct + Store / Todo / Intel — **not** a persisted compact blob.

---

## 5. Store hygiene (checkpoint, not a second session)

**Allowed typed writes:** Finding (existing book path), Surface, process fact (index + summary; body via `get`/`read`), living Intel on Host/Service.

**Forbidden dumps:** raw scanner stdout, every 404/retry, skill bodies, thinking text, restating the same fact in ten rows. Tool streams stay under `tool-output/` (existing governance).

**Inject caps** (compact / cold rehydrate): fact index ~40 (existing); living intel **≤50** (Scope Host-level + matching Scope Service ports; this-Case + login kinds first; see owner-intel); findings **≤20**; Todo = current product map.

**Enforcement:** tool schemas and existing size/L0 gates. **Not** platform NLP scrape of chat (`AGENTS.md`). Agent chooses what to persist; host rejects oversized bodies (`MAX_SUMMARY` / `MAX_BODY` on facts already).

### Persist cadence (locked with Intel map [#459](https://github.com/zangjiaao/my-ai-pen/issues/459) / [#471](https://github.com/zangjiaao/my-ai-pen/issues/471))

- **Mid-run:** Agent **may** `record_intel` / book / fact whenever it wants. **No** periodic nudge. Frequent mandatory writes are out.
- **At threshold:** one **persist pass** — a single structured follow-up (not NLP): occupancy is high; persist living intel (and other Store rows it already knows how to write) that should survive the smaller view; then continue. Host does **not** scrape the transcript.
- **If the pass writes nothing:** still shrink. Compact does not wait forever. Unwritten process is lost — that is acceptable.
- **Settle persist** (wrap / next_steps) is a **separate** optional notebook write (owner-intel persist cadence). It does not replace this compact pass; both may run in one Session.

---

## 6. UI

Platform Messages (thinking / text / `tool_output`) stay as already projected. Shrink does **not** delete chat history for the operator.

Optional later: Status chrome that occupancy shrink ran. **Not** Spec-blocking.

---

## 7. Today vs this Spec

| | Today (Node4) | This Spec |
|--|---------------|-----------|
| Mid-run shrink | None | Threshold + checkpoint view |
| `transformContext` | Unset | Product hook on `runNode4Agent` |
| Overflow | Generic `LlmTurnError` | Same channel + occupancy diagnosis |
| Graph new stage | New Agent | Unchanged (D) |
| Package worker | Own Agent | Unchanged (D); Main must not ingest child transcript |
| Intel inject | N/A (map #459) | `active` only, when Intel exists |

---

## 8. Non-goals

- Adopting `AgentHarness` / JSONL session compact as product Runtime.  
- Making Runtime transcript the SOT.  
- Raising outer-continue / premature-stop budgets as a substitute.  
- Keyword/regex “intent” to decide when to shrink.  
- Case-user compact slider.  
- Provider opaque compact blobs as SOT (OpenAI/xAI `/responses/compact`).

---

## 9. Implementation sketch (not code)

1. `runNode4Agent`: pass `transformContext` that (a) estimates occupancy from last assistant usage + trailing messages, (b) if ≥ threshold, builds the checkpoint view in section 3.  
2. Estimate: prefer provider `usage` on the last good assistant message (`estimateContextTokens` is allowed).  
3. Threshold parse: `NODE4_COMPACT_THRESHOLD` with disclosed default `0.8`.  
4. On shrink failure: count one retry; then `LlmTurnError` with diagnosis `occupancy` / provider context-length text.  
5. Tests: occupancy below threshold is a no-op; at threshold the next request must not contain pre-slice tool bodies; Store indexes still present; overflow still ≠ `natural_stop`.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-08-15 | First publish — map #461 / ticket #468. |
| 2026-08-15 | Persist cadence: optional mid-run writes; one Agent persist pass at threshold; then shrink (#471). |
| 2026-08-15 | Shipped: `NODE4_COMPACT_THRESHOLD` (default 0.8) + `transformContext` persist-then-checkpoint. |
| 2026-08-15 | Settle persist called out as a separate optional pass (does not replace compact persist). |
| 2026-08-15 | Living intel inject follows owner-intel Case hang filter (Host-level + Scope Service ports). |
| 2026-08-19 | Each model POST records UTF-8 body bytes to `piDir/llm-requests.jsonl` (and `events.jsonl`); no request body stored. |
