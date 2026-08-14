# Research: Expert Graph window pressure (stage isolation vs overflow)

**Date:** 2026-08-14  
**Scope:** Node4 Expert Graph × Pi as implemented today — does stage isolation **prevent** model context-window overflow, or only **reduce** it?  
**Question:** Overflow-proof vs work-splitting? Per-stage Agent lifecycle, same-stage park continue, in-stage growth, package workers, stage vs Free first-turn size, residual risk.  
**Sources:** Node4 runtime + living specs only (no product compact decision). Ticket [#463](https://github.com/zangjiaao/my-ai-pen/issues/463); map [#461](https://github.com/zangjiaao/my-ai-pen/issues/461).

---

## Executive answer

**Expert Graph is not overflow-proof.** It **reduces** window pressure by **splitting work** (new Agent per stage; Product-state handoff instead of prior-stage transcript) and by **per-call output caps**. It does **not** enforce a context-window budget, does **not** compact or evict history mid-stage, and **same-stage park continue reuses the same growing transcript**.

What already looks like structured compaction:

| Mechanism | What it drops | What it keeps |
|-----------|---------------|---------------|
| New `createBoundNode4Session` per stage (and per stage retry) | Prior stage **Runtime transcript** (messages / tool calls / skill bodies) | Product state: Finding Store, surface ledger, package terminals, session jars (A4), parent lifecycle observations |
| Handoff snapshot + sliced lists | Full prior-stage chat | `summary` + surfaces/candidates/facts/deadends (sliced) + completed_stages |
| Compact Profession on Graph / Package | Full pack `work.md` + platform-citizen longform | Marker-bearing profession core |
| Package worker own Agent | Child transcript never merged into Main | Structured settlement + acceptance JSON on the **parent** tool result |
| Per-tool output governance | Raw huge stdout (shell) | ≤ ~48k chars model-facing + disk archive |

**Verdict for Spec authors:** treat Graph as **stage-isolated work-splitting + Product-state continuity**, not as a context-window manager. Residual overflow is **in-stage** (long probe loops, park continue, many packages on Main, fat handoff/facts).

---

## 1. Per-stage Agent lifecycle

### New Agent each stage

`createHardGraphStageExecutor` builds a **stage-local workDir** (`taskDir/hard-graph/<graphId>/stage-<index>-<id>/`) and, on the live path, calls **`createBoundNode4Session`** with that stage’s `systemPrompt` (`hard-graph-stage-executor.ts`). `createBoundNode4Session` constructs a **new** pi-agent-core `Agent` (`run-node4-agent.ts`): `initialState.systemPrompt` + tools; `sessionId` is minted unless the caller passes one. The Graph stage path **does not pass** a prior `sessionId`.

The runner (`hard-graph-runner.ts`) owns stage order and, on pass, **`mergeHandoff`** then the next executor call. A stage **retry** is another executor invocation → another `createBoundNode4Session`. There is **no** attach of the previous attempt’s Agent.

`hard-graph-task.ts`: “Main OMP loop is not the stage scheduler. **Outer continues do not apply.**” Each stage is one `session.prompt(userPrompt)` then natural stop (`hard-graph-stage-executor.ts`).

### What the new Agent contains

Four-layer system prompt via `stageSystemPrompt` → `buildStagePromptLayers` (`prompt-layers.ts`, Spec `docs/specs/prompt-layers.md`):

| Layer | Graph stage contents |
|-------|----------------------|
| **Base** | Standing language + persona / pack meta (`buildBaseLayer`) |
| **Profession** | **`buildCompactProfessionLayer`** — marker-bearing mission/work only; drops platform-citizen longform and Free-mode pointers (`compactProfessionLayerInput`) |
| **Runtime** | Stage identity + success + allowed tools + host-owned settlement law + (if tools allow) package fan-out steer + fail-closed RoE one-liner. Optional: skill **L1** catalog (id/name/description, no bodies), hypothesis-queue injection **only when** `hypothesis_work_mode` is on |
| **Task** | `target` / `scope` JSON; `Prior handoff stages: completed_stages`; `Known surfaces` **sliced to 20**; prior Finding Store snapshot (`formatPriorSnapshotInjection`, ≤40 rows) |

**User prompt** (`stageUserPrompt`) is a **separate** first turn, not a second system dialect:

- stage id + success
- optional L0 repair brief (stage attempt > 1; machine template in `l0-honesty-repair-brief.ts`)
- book-stage confirmable `feedback_ok` list (≤40 rows)
- confirmed-not-seeded hyp projection (book stages)
- **Handoff snapshot JSON:** `summary`, `surfaces.slice(0, 40)`, `candidates.slice(0, 20)`, `deadends.slice(0, 20)`
- `task.instruction`
- stage footer (“Complete this stage only…”)

### What is **not** carried (prior stage transcript)

- Previous stage `Agent.state.messages` (tool calls, skill `load` bodies, assistant text) — **not** copied.
- Free **case-context** block (`formatCaseContextInjection`, ≤18k) — **not** in Graph stage system or user prompt.
- Free **process-fact index** (`formatProcessFactIndexInjection`, ≤40) — Free `buildPromptLayers` Task only; Graph stage Task does not inject it.
- Full pack Profession + full `<rules-of-engagement>` block — Free Runtime; stage has compact Profession + fail-closed one-liner.

Continuity that **is** carried is **Product state**, not transcript (`CONTEXT.md` Product state vs Runtime transcript; `docs/specs/task-graph.md` A1/A4):

- `seedChildSessionFromParent` / `promoteChildSessionToParent` — **cookie jars**, not messages
- `seedStageLifecycleFromParent` — parent `recentObservations` + subagent evidence cache (booking ground; `RECENT_OBS_CAP` = 80)
- Finding Store / surface ledger / host settlement — gate SoT; **not** agent `result.json`
- Handoff object in the runner (`mergeHandoff`)

This is the structured-compaction lookalike: **transcript dies with the stage Agent; Product-state slices seed the next Agent.**

---

## 2. Same-stage park continue (Spec #283 / #354)

**Yes — attach reuses the same Agent and therefore the same growing transcript.**

| Fact | Source |
|------|--------|
| Stage `finally` **parks** the captain (`applyCaptainEndDisposition` / `decideParkOnEnd`) — interrupt **and** package settle; dispose only via whitelist | `hard-graph-stage-executor.ts`, `working-session-park.ts`, Spec #354 |
| Park holds the live `Node4AgentSession` (the pi `Agent`) + Todo + runtime | `ParkedWorkingRuntime` |
| Next `runNode4Task` resolves park **before** Hard Graph re-entry | `session-runner.ts` |
| Attach → `runParkedWorkingContinue`: `session.prompt(task.instruction)` on **`parked.session`**; `sameRuntime: true` | `run-parked-working-continue.ts` |
| Continue body is **operator utterance only** — no cold multi-block rebuild | Spec #455 / comment on `runParkedWorkingContinue` |
| Observable: `parkedSessionHasHistory` = `session.messages.length > 0` | `working-session-park.ts` |
| Spec: continue = next turn on **same pi session** with retained transcript/todos | `docs/specs/task-graph.md` UI interrupt; `participant-session.md` I0.9-W1; `CONTEXT.md` User interrupt |

**Not attach (reseed / new Agent):**

- C1 post-complete free-in-envelope (`continueInEnvelope` → reseed, drop Graph park)
- Park miss / TTL / mode_mismatch
- Session Reset (`needsAgentReseed` — new `Agent`, keep Todo)

**Stage-to-stage inside one Graph burst** does **not** attach the park: the runner calls the executor again (`createBoundNode4Session`). The previous stage’s park sits until the next stage `finally` **replaces** it (`parkWorkingSession` disposes the prior entry). Overflow isolation between stages holds; isolation **within** a parked stage does **not**.

Repeated same-stage「继续」**appends** user + assistant + tool turns. There is no host compaction on attach.

---

## 3. In-stage growth

Graph stage loop = **one** `session.prompt` then stop. Product outer-continue budgets default **0** (`loop-policy.ts` / `hard-graph-task.ts`). Discovery stays **in-loop**: pi keeps tool-calling until the model emits no tools.

### Per-tool caps still accumulate

| Cap | Applies to | Accumulates? |
|-----|------------|--------------|
| `MODEL_TOOL_OUTPUT_CHARS = 48_000` (`tool-output-governance.ts`) | **Shell** stdout+stderr (head/tail + archive) | **Yes** — each call can add ~48k to **this** Agent’s messages |
| HTTP `body_preview` 8k (`http.ts`) | http tool | Yes |
| Browser snapshots 10–16k (`browser.ts`) | browser tool | Yes |
| `TOOL_RESULT_TEXT_WIRE_MAX = 12_000` | **Platform wire** only (`tool-result-wire.ts`) — **not** the model transcript | N/A for overflow |
| Process-fact body 50k store-side; index inject 40 (`process-fact.ts`) | fact tool / Free Task inject | Get-body can be large **if the agent calls get** |
| `RECENT_OBS_CAP = 80` | parent lifecycle observations (not the model window by itself) | Cap on Product-state list |

There is **no** Graph-wide or stage-wide sum of tool-output chars. N shell calls ≈ N × ≤48k **in the same messages array**.

### Skill `load` bodies remain in history

`skill` tool: `list` | `load` only — **no unload** (`node4/src/tools/skill.ts`). `load` returns the **full body** in the tool result (that message stays in the Agent transcript). Same-id reload with identical fingerprint returns a short `already_loaded` note — **does not remove** the first body. Graph Runtime injects **L1 catalog only** (`skill-l1-catalog.ts`; `skillL1InjectionHasNoBodies` treats >12k injection as failed). Worker cold start may inject **one** body sliced to **12_000** in system Runtime (`subagent-session.ts`).

Pack policy (“at most one / never bulk-load”) is **prompt**, not a host eviction of history tokens.

### No overflow guard in Node4

`run-node4-agent.ts` sets `contextWindow` only when synthesizing an unknown model (`LLM_CONTEXT_WINDOW` default 128_000). No Graph path trims `agent.state.messages`. Grep of `node4/src/runtime` finds **no** transcript compaction / overflow handler.

---

## 4. Package workers: own Agent / own window

Cold package: `runSubagentLlmSession` → **`createBoundNode4Session`** with `subagentDepth: 1`, compact Profession + return contract + optional one skill body (`subagent-session.ts`). Child **does not inherit parent chat** (`childRolePack`: “You do NOT inherit parent chat”).

**What returns to Main** (`node4/src/tools/subagent.ts` `jsonResult`):

- `summary`, `structured` (ok/summary/candidates/surfaces ± hypothesis_outcomes), `acceptance`, `handoff`, `session_reuse` / `resume_hint`
- **Not** the child’s `session.messages`

Parent also records a **≤48k** observation blob (`buildParentObservationBlob` / `injectParentObservationsFromChild`) for proof grounding — Product-state / observation list, **plus** the JSON tool result sitting in **Main’s** transcript.

### Worker reuse (second window-pressure path)

Idle pool parks the **same child Agent** after success/soft-fail (`subagent-idle-pool.ts`: default maxIdle 8, TTL 420s, **maxPackages 4**). Warm resume: `buildUserPrompt(..., resume: true)` says **“Prior tool history may be in context.”** Same-path follow-up **grows the worker window**. Release/dispose wipes that Agent (`session.dispose` → `Agent.reset`).

Main’s window grows by **N package tool-results** (structured JSON, not child transcripts). Workers’ windows grow independently; warm workers grow across up to 4 packages.

---

## 5. Stage prompt size vs Free first-turn (order of magnitude)

Measured from **builder source + pack files** (this worktree has no `node4/node_modules`; no live assembler run). Guidance budgets: `docs/specs/prompt-layers.md` §3.7.

| Block | Free first-turn | Graph stage first-turn |
|-------|-----------------|------------------------|
| **Base** | Standing + persona — same helper | Same `buildBaseLayer` |
| **Profession** | **Full** mission+work + pack-load citizen (`PLATFORM_CITIZEN_MISSION_LINES` ~1k+; `experts/pentest/work.md` ~4.8k; `mission.md` ~0.7k). Tests: `work.md` prefer &lt;4.5k (`prompt-layers.test.ts`) | **Compact** filter — tests assert `layers.profession.length < freeLayers.profession.length` (`hard-graph-stage-prompts.test.ts`) |
| **Runtime** | Tools + booking note + **thin Free** work-mode + skill **ids** + full `formatRoeInjection` + optional Graph **L1 catalog** (id/label/when_to_use). Free work-mode test: &lt;800 chars | Stage law + package steer (~2–4k static) + optional skill L1 (≤80 × ~200-char desc; helper flags &gt;12k) + optional hyp queue (≤24 active + 8×3 other rows) — **not** full Free RoE |
| **Task (system)** | Case context **≤18k** + fact index ≤40 + target/scope/accounts/instruction/goals | Target/scope + completed_stages + **20** surfaces JSON + prior snapshot ≤40 — **no** case context, **no** fact index |
| **User / first turn** | `session-runner.ts` **re-injects** case context (again ≤18k), RoE, work-mode, target/scope, instruction | `stageUserPrompt`: handoff JSON (40/20/20) + instruction + optional L0 brief / book list — **no** case-context dual dump |

**Order of magnitude (pentest, typical small Case):**

- Free system+user first injection: **~15–40k chars** (Profession+RoE+tools plus up to **two** 18k case-context copies in the worst Case).
- Graph stage system+user: **~8–25k chars** typical; **upper tens of k** if skill L1 is large **and** handoff/priors/hyp queue are near their slice caps.
- Both are **first-turn tens of kilobytes**, not a 128k window by themselves.

**The window problem is not the stage header.** It is **in-stage N × tool results** (and park-continue appends). Graph first-turn is often **leaner** than Free (compact Profession, no case-context dual inject) but **fatter in Runtime law** and **handoff JSON**.

---

## 6. Honest residual risk

**Graph is not overflow-proof.** Paths that can still blow a 128k-class window:

| Path | Why it can overflow | Isolation? |
|------|---------------------|------------|
| **Long probe / serial Main stage** | In-loop tools until natural stop; each shell ≤48k stays in **this** Agent; skill bodies stay; no outer continue but also **no** stop on token count | New Agent only at **next stage** / retry |
| **Same-stage park continue** (#283 / #354) | Attach **same** `messages`; each continue adds another user+tools burst | **None** until Reset / dispose / next stage (next stage only if runner re-enters, not attach) |
| **Huge handoff / facts** | Runner `mergeHandoff` keeps **all surfaces** (deduped by location) + candidates/facts/deadends **slice(0, 80)**; prompt then re-slices 40/20/20. Fat candidate `proof_excerpt`s still serialize. Prior snapshot 40 rows; hyp queue budgeted but not tiny | Next stage still **injects the snapshot** even with a fresh Agent |
| **Many packages on Main** | Each `subagent` tool result is structured JSON + acceptance **in Main transcript**; ≤48k observation blob also recorded. Batch default concurrency 8, hard batch 32, task budget 128 (`docs/specs/task-graph.md`) | Workers isolated; **Main is not** |
| **Warm worker resume** | Child history retained up to 4 packages | Worker-local; Main still gets a new JSON result each time |
| **Stage retry** | New Agent (good) but L0 brief + **same accumulated handoff** re-injected | Transcript isolated; snapshot can still be large |
| **Book stage with many `feedback_ok`** | Captain list ≤40 ids + `finding(list)` tool results in-loop | Moderate |

**Does not overflow the stage window (by design):** prior stage chat; child worker transcripts; archived full shell files (unless the agent `read`s them back).

---

## What Graph already does that looks like compaction

Do **not** invent a second compaction product. These already exist:

1. **New Agent per stage / retry** — transcript hard-reset (`createBoundNode4Session` without prior `sessionId`).
2. **Product-state handoff** — Store / ledger / host settlement / sliced handoff JSON (`hard-graph-runner.ts` `mergeHandoff`; Spec #125).
3. **Compact Profession + L1 skill catalog** — encyclopedia out of always-on (`prompt-layers.md`).
4. **Package isolation** — child window + structured return (`subagent-session.ts`).
5. **Per-call output truncate + archive** (`tool-output-governance.ts`).
6. **Skill reload dedupe** (no second full body; first body remains).
7. **Session Reset** — dispose Agent, mint new id, keep Todo (`resetWorkingSessionMemory`) — operator-triggered, not automatic on pressure.

Missing (facts, not a proposal): any host pass that **shrinks `agent.state.messages`** when approaching `contextWindow`; any stage-level tool-output **sum** cap; any unload of skill bodies from history.

---

## Risk table (short)

| Graph path | Overflow-proof? | Dominant tokens |
|------------|-----------------|-----------------|
| Stage N → stage N+1 (same burst) | **No, but reduced** — new Agent; residual = handoff/facts/priors | Snapshot, not prior chat |
| Stage retry (L0/L1) | **Same as above** | L0 brief + same snapshot |
| Long in-stage probe (serial or many tools) | **No** | N × tool results + skill bodies |
| Interrupt → same-stage continue | **No** — **same Agent / same transcript** | All of the above **plus** continue turns |
| C1 after Graph complete | Reseed (not attach) — new Free/envelope Agent | Case context / instruction, not last-stage chat |
| Package worker cold | Own window; Main gets summary JSON | Worker: tools; Main: structured result |
| Package worker warm | **No** (history kept, max 4 packages) | Worker transcript across packages |
| Many packages on captain | **No** | Sum of package JSON on Main |

**One-line answer:** Graph **is not** overflow-proof; it **is** stage-isolated work-splitting with Product-state handoff standing in for transcript compaction.

---

## Source index

| Source | Role |
|--------|------|
| `node4/src/runtime/hard-graph-stage-executor.ts` | Per-stage `createBoundNode4Session`, `stageUserPrompt` slices, park-on-finally, single `prompt` |
| `node4/src/runtime/hard-graph-runner.ts` | `HardGraphHandoff`, `mergeHandoff` (surfaces unbounded-dedup; candidates/facts/deadends ≤80) |
| `node4/src/runtime/hard-graph-task.ts` | Graph path; no outer continues |
| `node4/src/runtime/run-node4-agent.ts` | New `Agent` + `systemPrompt`; no message trim |
| `node4/src/runtime/working-session-park.ts` | Park/attach/reseed; history observable |
| `node4/src/runtime/run-parked-working-continue.ts` | Same session `prompt(instruction)`; `sameRuntime: true` |
| `node4/src/runtime/session-runner.ts` | Park resolve **before** Hard Graph; Free first-turn dual case-context |
| `node4/src/runtime/prompt-layers.ts` | Compact Profession; stage vs Free layers |
| `node4/src/runtime/subagent-session.ts` | Worker own Agent; resume keeps history; skill body ≤12k inject |
| `node4/src/runtime/subagent.ts` / `node4/src/tools/subagent.ts` | Return summary/structured/acceptance — not child transcript |
| `node4/src/runtime/subagent-idle-pool.ts` | Warm worker bounds (8 / 420s / 4 packages) |
| `node4/src/runtime/tool-output-governance.ts` | 48k model-facing shell cap |
| `node4/src/tools/skill.ts` | list/load; no unload; reload dedupe |
| `node4/src/runtime/hard-graph-continuity.ts` | Product-state seed/absorb; not transcript |
| `node4/src/runtime/loop-policy.ts` | In-loop tools; product outer continues off |
| `docs/specs/prompt-layers.md` | Four layers; compact Profession; size guidance |
| `docs/specs/task-graph.md` | Handoff = host settlement; park = same pi session |
| `docs/specs/participant-session.md` / `session-owns-runtime.md` | #283 / #354 attach semantics |
| `CONTEXT.md` | Product state SOT vs Runtime transcript |

---

*Living research note for Spec authors. Not product authority; does not change harness.md or add a compact product until a Spec lands.*
