# Research: pi Agent Runtime seams for hard Graph orchestration

**Ticket:** [#10](https://github.com/zangjiaao/my-ai-pen/issues/10) · Map [#8](https://github.com/zangjiaao/my-ai-pen/issues/8)  
**Branch:** `research/pi-graph-seams`  
**Scope:** Evidence only — no product implementation.  
**Sources:** `node4` deps on `@earendil-works/pi-*` (`file:../research/pi/packages/*`), `research/pi` package APIs (gitignored third-party clone), `node4/src/runtime/*`, living `docs/specs/task-graph.md`.

---

## 1. Verdict (one paragraph)

**Graph × Pi is architecturally coherent if and only if ownership is inverted:** an *external* hard Graph orchestrator owns Task / stage edges / Feedback gates, and pi is a **light node agent runtime** (session + tools + transcript) that runs inside graph nodes. It is **not** coherent to treat today's node4 “Graph mode” as already hard Graph — that mode is OMP-first soft discipline (prompt injection + optional Main tool strip + `node_type` allowlist), with the Main LLM still scheduling work via `subagent`. The clean seams exist in pi (`createAgentSession`, `prompt`/`abort`/`dispose`, `setActiveToolsByName`, extension `tool_call` block, event `subscribe`) and in node4 wrappers (`SubagentHost`, handoff/result contracts, child tool allowlist). Hard Feedback gates are **not** a first-class pi API; they must sit *outside* the agent loop, consuming structured artifacts.

---

## 2. Dependency map (what node4 actually binds)

From `node4/package.json`:

| Package | Path | Role in node4 |
|---------|------|----------------|
| `@earendil-works/pi-coding-agent` | `research/pi/packages/coding-agent` | Primary product surface: `createAgentSession`, `AgentSession`, extensions, tools registry, `SessionManager` |
| `@earendil-works/pi-agent-core` | `research/pi/packages/agent` | Lower loop: `Agent`, `runAgentLoop`, optional `AgentHarness`, session JSONL types, tool hooks |
| `@earendil-works/pi-ai` | `research/pi/packages/ai` | Models, streaming, providers |

**Usage pattern today:** node4 does **not** construct `AgentHarness` or raw `Agent` for product tasks. It always goes through:

```ts
createAgentSession({ cwd, model, tools, resourceLoader, sessionManager, ... })
→ session.prompt(...)
→ session.abort() / session.dispose()
```

Cited: `node4/src/runtime/session-runner.ts` (`runNode4Task`), `node4/src/runtime/subagent-session.ts` (`runSubagentLlmSession`).

`research/pi` is under `.gitignore` (`research/`) and is a frozen local clone; node4 pins it via `file:` deps. API claims below refer to that clone’s source.

---

## 3. pi surfaces (sessions, tools, multi-agent, lifecycle)

### 3.1 Session start / stop / prompt

**Factory:** `createAgentSession(options: CreateAgentSessionOptions)`  
Symbol: `research/pi/packages/coding-agent/src/core/sdk.ts` → `createAgentSession`

Key options relevant to external orchestration:

| Option | Seam meaning |
|--------|----------------|
| `cwd` | Node workspace root for tools / relative paths |
| `model` / `thinkingLevel` | Per-node model policy |
| `tools` | **Allowlist** of active tool names at session create |
| `excludeTools` | Denylist after allowlist |
| `noTools` | `"all"` starts with zero tools |
| `customTools` / extension `registerTool` | Register product tools |
| `resourceLoader` | System prompt, extension factories, skill discovery |
| `sessionManager` | Transcript persistence (`SessionManager.create` / in-memory) |

**Session control API** (`AgentSession` in `research/pi/packages/coding-agent/src/core/agent-session.ts`):

| Method / property | Behavior for orchestrator |
|-------------------|---------------------------|
| `prompt(text, options?)` | Start (or queue) a user turn; awaits full agent run |
| `abort()` | Abort low-level run + `waitForIdle()` |
| `dispose()` | Abort hooks + disconnect listeners; end of life |
| `subscribe(listener)` | Observe session events (token stream, tool, turn) |
| `messages` | Full transcript (`agent.state.messages`) |
| `setActiveToolsByName(names)` | Constrain tools; **takes effect on next turn** |
| `getActiveToolNames()` | Read current tool set |
| `steer` / `followUp` / `sendMessage` | Mid-run injection without owning the loop |
| `sessionId` / `sessionFile` | Durable identity / path |

Low-level twin (`research/pi/packages/agent/src/agent.ts` class `Agent`):

- `subscribe`, `abort`, `waitForIdle`, `steer`, `followUp`, `reset`
- Mutate `state.tools` / `state.messages` / `state.systemPrompt`
- Hooks: `beforeToolCall` → `{ block?: boolean; reason? }`, `afterToolCall` overrides, `prepareNextTurn`, `shouldStopAfterTurn` (on loop config)

**Orchestrator mapping:**

| Graph need | Clean pi seam |
|------------|---------------|
| Start node agent | `createAgentSession` + first `prompt` |
| Stop / cancel | `abort()` (cooperative) then `dispose()` |
| Hard kill after timeout | race `prompt` vs timer → `abort` (node4 already does this in `raceSessionPrompt`) |
| Per-stage re-prompt | subsequent `prompt` on **same** session, or new session per node |
| Isolate workspaces | distinct `cwd` + `SessionManager` path per node |

### 3.2 Tools: register, constrain, block

Three layers (outer → inner):

1. **Create-time allowlist** — `CreateAgentSessionOptions.tools` / `excludeTools`  
2. **Runtime allowlist** — `AgentSession.setActiveToolsByName` / extension `pi.setActiveTools`  
3. **Per-call gate** — extension event `tool_call` can return `{ block: true, reason? }` (`ToolCallEventResult` in coding-agent extensions types); low-level `beforeToolCall` same shape

Node4 product tools are registered only via extension:

- `createNode4Extension` → `pi.registerTool(tool)` for each pack tool  
  (`node4/src/runtime/extension.ts`)
- Main tool list: `toolNamesForPack(pack)` then optional `applyMainActToolFilter`  
  (`session-runner.ts`, `pentest-graph.ts`)
- Child tool list: fixed `SUBAGENT_CHILD_TOOL_NAMES` (no `subagent`, no `finding`)  
  (`subagent-session.ts`)

**Important constraint:** `setActiveToolsByName` docs say changes apply on the **next** agent turn, not mid-tool-batch. Hard stage switches that must cut tools immediately either (a) end the turn / session and start a new one with a new allowlist, or (b) also install a `tool_call` block denylist that fails closed.

### 3.3 Multi-agent / subagent

**pi itself has no first-class multi-agent graph.** Multi-agent is application-level:

- Separate `AgentSession` instances (node4: Main session + N child sessions)
- Optional keep-alive pool (`SubagentIdlePool`) keyed by `agent_id` / path affinity
- Nest ban: `assertSubagentNestAllowed(depth)` — children must not spawn children

What pi *does* provide that multi-agent builds on:

- Independent sessions + JSONL transcripts
- Tool isolation via allowlists
- Extension isolation per session (each child builds its own `DefaultResourceLoader` + extension)
- Event streams per session for parent observability

### 3.4 Lifecycle hooks / events

**Coding-agent extensions** (what node4 uses):

| Event | Can mutate / gate? | node4 use today |
|-------|--------------------|-----------------|
| `tool_call` | Yes — `block`, mutate `input` | Observability only (`extension.ts`); returns `undefined` |
| `tool_result` | Observe / post-process | Platform `tool_output` + mid-run todo nudge |
| `input` | Transform / handle | unused in node4 |
| `before_agent_start` / `agent_end` / turn events | Lifecycle | platform observability via `session.subscribe` |
| `session_before_compact` / tree events | Cancel-style | unused |

**AgentHarness** (`research/pi/packages/agent/src/harness/*`, docs `agent-harness.md`, `hooks.md`):

- Richer phase model: `"idle" | "turn" | "compaction" | "branch_summary" | "retry"`
- Structural ops require idle; `abort` / queue ops allowed mid-turn
- Typed hook system with reducers (`tool_call` block, context rewrite, provider payload)
- **Not wired by node4 product path** — relevant only if a future runtime drops down from `AgentSession` to harness, or pi consolidates

**Low-level `AgentEvent`** (`research/pi/packages/agent/src/types.ts`):

`agent_start` → `turn_start` → message/tool events → `turn_end` → `agent_end`  
Listeners are **awaited** as part of run settlement (`waitForIdle` after `agent_end`).

### 3.5 Structured state in / out (pi native)

| Direction | Native support | Practical seam |
|-----------|----------------|----------------|
| In: system policy | `systemPrompt` on resource loader / agent state | Inject graph stage brief at session create or rebuild prompt |
| In: user package | `prompt(text)` | Handoff markdown / JSON string |
| In: mid-run steer | `steer` / `followUp` / `sendMessage({ deliverAs })` | Soft only — model may ignore |
| Out: transcript | `session.messages`, session JSONL files | Audit / salvage |
| Out: tool results | events + tool-result messages | Weak for gates |
| Out: **structured business result** | **None as protocol** | App must define file/tool/schema (node4: `result.json`) |

pi will not emit typed `SubagentStructuredResult` for you. That is entirely host contract.

---

## 4. node4 runtime map (how seams are used today)

### 4.1 Main harness loop

`runNode4Task` (`session-runner.ts`):

1. Resolve pack + optional `resolvePentestGraph` → soft/hard Main tool filter  
2. `createAgentSession` with filtered `tools` + `createNode4Extension`  
3. Single (or outer-continue) `session.prompt` cycles via `loop-policy`  
4. Platform cancel → `session.abort` + idle-pool `disposeAll`  
5. Settlement via harness/booking policy — **not** a Graph edge machine  

Outer continues are product/lab policy around natural stop; they are not Graph stages.

### 4.2 Soft Graph (not hard)

`pentest-graph.ts` + `docs/specs/task-graph.md`:

- Modes: `free` | `graph`  
- Product Graph default: **soft** (`main_act: delegate_preferred`) — Main may act  
- Lab hard: strip Main act tools (`MAIN_DELEGATE_ONLY_STRIP`) via `applyMainActToolFilter` when `main_act === "delegate_only"`  
- `force_order` is **always soft** (comment + injection text)  
- Node legality: `assertNodeAllowed` / `graphCtx.assertNode` on subagent dispatch only  
- Scheduling owner remains **Main LLM** calling tool `subagent`

This is **prompt + tool-surface discipline**, not an external Task→Agent→Feedback engine.

### 4.3 Subagent as de-facto node worker

| Piece | Path | Seam |
|-------|------|------|
| Host spawn / evidence | `subagent.ts` `SubagentHost.spawn` | Injectable `worker`; writes `assignment.md` + `result.json` artifact; platform events |
| Handoff validation | `subagent-handoff.ts` `validateSubagentHandoff` | Required fields: target, scope, already_done, this_turn_goal, success_criteria |
| LLM child session | `subagent-session.ts` `runSubagentLlmSession` | Cold `createAgentSession` or warm idle re-`prompt`; natural stop; timeout race |
| Child tools | `SUBAGENT_CHILD_TOOL_NAMES` | Hard allowlist (no nest, no book) |
| Result contract | `subagent-result.ts` `normalizeSubagentResult` | candidates / surfaces / facts / deadends / artifacts |
| Assistive Feedback | `evaluateCandidatesForAcceptance` | **Hints to Main**, explicitly *not* a settlement gate |
| Idle keep-alive | `subagent-idle-pool.ts` | Reuse session by `agent_id` + path affinity |
| Session cookie continuity | `subagent-session-seed.ts` | Parent↔child jar seed/promote |
| Tool entry | `tools/subagent.ts` | Graph `node_type` check, path re-dispatch budget, batch concurrency |

**Acceptance loop documented in `docs/specs/task-graph.md`:**

```text
Main DISPATCH → Sub EVIDENCE → Main JUDGE → book | re-dispatch | deadend
```

Judge is still the **Main agent** (LLM + assistive `acceptance` blob), not a hard Graph Feedback node.

### 4.4 Structured I/O contracts (best current external seams)

**In (per package):**

```ts
// subagent-handoff.ts
SubagentHandoffFields {
  target, scope, already_done, this_turn_goal, success_criteria
}
```

**Out (per package):**

```ts
// subagent-result.ts
SubagentStructuredResult {
  ok, summary, candidates[], surfaces[], facts[], deadends[], artifacts[], notes?
}
```

Collection path: prefer `workDir/result.json` → else salvage from tool-output/facts (`subagent-salvage.ts`).

These contracts are the **right shape** for Feedback gates if ownership moves outside Main.

---

## 5. Clean seams for an *external* hard Graph orchestrator

Design target (from map #8 preference): hard Graph owns flow; pi runs light agents inside nodes.

### Seam A — Node agent lifecycle (start / stop)

| Orchestrator action | Call surface |
|---------------------|--------------|
| Create node runtime | `createAgentSession` with stage-specific `cwd`, `tools`, system prompt, model |
| Run package | `session.prompt(stageBrief + structuredHandoff)` |
| Cancel | `session.abort()` then await idle / `dispose()` |
| Timeout | race (as `raceSessionPrompt`) |
| Parallel fan-out | N independent sessions (or reuse node4 `mapWithConcurrencyLimit` pattern) — **orchestrator schedules**, not Main tool |

**Do not** rely on Main voluntarily calling `subagent` if Graph is hard. That keeps the LLM as the scheduler.

### Seam B — Structured state in

Preferred channel order:

1. **System prompt / stage pack** (immutable policy, tool menu, RoE) at session create  
2. **User prompt handoff** (`validateSubagentHandoff`-shaped package) as the only objective  
3. **Workspace files** (ledger, facts, surfaces) under node `cwd` for durable shared Case state  
4. **Avoid** mid-run `steer` as the sole hard input path (best-effort)

Case-level shared state should live **outside** pi (platform / taskDir stores), with each node session given a read path.

### Seam C — Structured state out / Feedback inputs

| Artifact | Gate use |
|----------|----------|
| `result.json` → `normalizeSubagentResult` | Primary structured package for Feedback |
| `SubagentHost` evidence record | Auditable attachment |
| Session transcript / tool-output | Salvage / dispute only |
| `evaluateCandidatesForAcceptance` | **Library helper** for Feedback *logic*, not auto-gate |

Hard Feedback node should:

1. Require schema validation (fail closed if missing fields for stage)  
2. Map `ready_to_book` / `package_gaps` / ledger updates to **edge decisions**  
3. Never re-enter the same pi session hoping the model “finishes correctly” without a new prompt package

### Seam D — Constrain tools per stage

| Mechanism | Hardness | Notes |
|-----------|----------|-------|
| Create-time `tools: [...]` | Strong | Best for stage-scoped sessions |
| `setActiveToolsByName` between prompts | Strong next-turn | Same session multi-stage |
| `tool_call` → `{ block: true }` | Strong per call | Defense in depth; fail-closed denylist |
| Prompt “do not use X” | Soft | Insufficient alone for hard Graph |
| `applyMainActToolFilter` | Strong but Main-centric | Lab captain mode pattern |

Recommendation for hard Graph: **one session (or one warm worker) per stage package** with create-time allowlist = stage tool profile. Use `tool_call` block as safety net, not primary policy.

### Seam E — Collect results for Feedback gates

Minimal external loop (conceptual — not implemented):

```text
for stage in graph.plan_or_dynamic_edges:
  session = createAgentSession(stage.toolProfile, stage.cwd)
  session.prompt(formatHandoff(stage.inputs))
  await idle / timeout
  structured = normalizeSubagentResult(read result.json | salvage)
  decision = Feedback(stage.success_schema, structured, case_state)
  case_state = apply(decision)
  session.dispose() or park if affinity resume
```

Reuse node4 pure functions: handoff validate, result normalize, acceptance evaluate, surface ledger merge — **lifted out of Main tool path**.

### Seam F — Observability (non-authoritative)

- `session.subscribe` / extension tool events → platform streaming  
- Must not be the Feedback source of truth (racey, incomplete vs `result.json`)

---

## 6. Architectural coherence: Graph × Pi

### Coherent shape

```text
┌─────────────────────────────────────────────┐
│  Hard Graph orchestrator (external)         │
│  Task · edges · retries · Feedback gates    │
│  Owns: stage order, budgets, tool profiles  │
└───────────────┬─────────────────────────────┘
                │ start/stop · handoff · schema check
                ▼
┌─────────────────────────────────────────────┐
│  pi Agent Runtime (light)                   │
│  AgentSession + tools + transcript          │
│  Optional: node4 SubagentHost wrappers      │
└───────────────┬─────────────────────────────┘
                │ tools → sandbox / Case files
                ▼
┌─────────────────────────────────────────────┐
│  Case / platform stores (durable state)     │
└─────────────────────────────────────────────┘
```

### Incoherent shapes (avoid)

1. **Soft Graph as hard Graph** — today’s `pentest-graph` + Main `subagent` scheduler  
2. **pi AgentHarness as product Graph** — harness is session/turn orchestration, not Task/Feedback  
3. **Prompt-only force_order** — model non-compliance is not a gate failure  
4. **Double schedulers** — Graph edges *and* Main outer-continue *and* mid-run steers competing  

### Relation to Node5 fallback

Node5 (ADK Graph+Agent) is the formal pure-Graph fallback if hybrid cost is too high. This research says hybrid is **feasible at the API seam level**; cost is in **ownership inversion + Feedback/schema productization**, not in missing `abort`/`tools` primitives.

---

## 7. Hard integration risks

1. **Scheduler ownership inversion**  
   Today Main LLM is the dispatcher. Hard Graph must stop treating `subagent` as the control plane or accept non-determinism. Risk: hybrid that “adds Graph” while Main still freelances.

2. **No native structured-output protocol in pi**  
   Results depend on model writing `result.json` (or salvage). Feedback gates that require high precision must add schema enforcement, retries, or tool-enforced finalization — none exist as pi core.

3. **Tool constraint timing**  
   `setActiveToolsByName` is next-turn. Mid-turn stage switches are racy. Prefer new session / end-of-turn boundaries.

4. **Session identity vs Graph node identity**  
   Warm idle pool is path/`agent_id` affinity, not graph-node-state. Reusing a worker across stages can pollute context (prior goals, tools memory). Risk: anti-pollution goals fight keep-alive thrift.

5. **Assistive acceptance ≠ hard Feedback**  
   `evaluateCandidatesForAcceptance` is explicitly non-settlement. Elevating it to a gate changes product semantics (may re-open “gate-first” anti-patterns from `AGENTS.md` Harness Over Restriction). Gates must be schema/evidence based, not coverage scoreboards.

6. **Dual lifecycle stacks**  
   Product uses coding-agent `AgentSession` + extensions; agent-core also has `AgentHarness` hooks. Integrating against the wrong layer wastes effort; extensions already provide `tool_call` block.

7. **Abort / dispose races under concurrency**  
   Parallel packages + shared parent stores (ledger mutex, session jar promote) are subtle. External Graph fan-out must re-solve shared-state locking (node4 already serializes some post-process).

8. **Outer continue vs Graph retry**  
   node4 outer continues (booking gap, goal, premature) can fire after natural stop. A hard Graph that also retries stages can double-spend budget unless continues are disabled for Graph-owned runs.

9. **System prompt rebuild coupling**  
   Tool allowlist changes rebuild system prompt text. Stage-specific skills/prompts must be re-injected carefully or nodes see stale policy.

10. **research/pi is a file: clone**  
    Not a published semver surface. Harness hook design docs may lead implementation; coding-agent is the stable product binding. Breaking changes land via local clone updates.

11. **Natural-stop completion ambiguity**  
    pi stops when the model stops calling tools (plus queues). There is no `finish(structured)` tool required by the loop. Orchestrators that assume “prompt returns ⇒ success schema satisfied” will be wrong.

12. **Hard Main tool strip is not full Graph**  
    `delegate_only` only removes act tools from Main; it does not encode edges, Feedback, or stage success. Treating captain mode as “hard Graph done” underestimates the gap.

---

## 8. What can be reused vs what must be new

| Reuse as library (good seams) | Must be new for hard Graph |
|-------------------------------|----------------------------|
| `createAgentSession` lifecycle | External Graph runner (Task/edges/Feedback) |
| `validateSubagentHandoff` / `formatHandoffPackage` | Graph definition ownership (experts packs vs runtime) — open on map #8 |
| `normalizeSubagentResult` / salvage | Stage success schemas & fail-closed Feedback |
| `SUBAGENT_CHILD_TOOL_NAMES` pattern | Per-stage tool profiles driven by Graph, not pack-wide |
| `SubagentHost` workspace + evidence | Drop Main-as-scheduler; optional keep Main as a *node type* only |
| `applyMainActToolFilter` idea | Generalized stage tool policy |
| Surface ledger / Case stores | Graph writes edges from ledger Feedback, not prompt honesty alone |
| Extension `tool_call` block | Stage denylist enforcement |
| Idle pool (optional) | Affinity keys aligned to Graph resume policy |

---

## 9. Answers to ticket questions (checklist)

| Question | Answer |
|----------|--------|
| How does pi expose sessions? | `createAgentSession` → `AgentSession` with JSONL `SessionManager`; prompt/abort/dispose/subscribe |
| Tools? | Register via extensions; constrain via create-time list + `setActiveToolsByName` + `tool_call` block |
| Multi-agent/subagent? | Application-level multiple sessions; node4 `SubagentHost` + LLM child sessions; no pi-native graph |
| Lifecycle hooks? | Extension events + `Agent` listeners + optional AgentHarness (unused by node4) |
| Start/stop for external Graph? | Clean: create/prompt/abort/dispose (proven in session-runner + subagent-session) |
| Structured state in/out? | In: prompt + cwd files; Out: app `result.json` contract (not pi-native) |
| Constrain tools per stage? | Clean if stage-scoped sessions; next-turn caveat for mid-session switches |
| Collect for Feedback gates? | Clean *if* Feedback owns schema check outside pi; acceptance helper reusable |
| Graph × Pi coherent? | **Yes, with ownership inversion**; **no** if soft Graph/OMP is merely renamed |
| Hard risks? | §7 (scheduler, structured I/O, tool timing, identity pollution, gate philosophy, dual stacks, concurrency, continue collision, natural-stop) |

---

## 10. Non-goals / out of scope (this ticket)

- No prototype of Graph × Pi  
- No PK winner declaration  
- No product doc rewrite of `harness.md` / `task-graph.md` beyond this research note  
- No Node5 deep dive (separate map research may cover ADK Feedback semantics)

---

## 11. Key file index

| Area | Paths |
|------|-------|
| Deps | `node4/package.json` |
| Main loop | `node4/src/runtime/session-runner.ts` |
| Soft Graph | `node4/src/runtime/pentest-graph.ts`, `docs/specs/task-graph.md` |
| Extension hooks | `node4/src/runtime/extension.ts` |
| Subagent host | `node4/src/runtime/subagent.ts` |
| Child session | `node4/src/runtime/subagent-session.ts` |
| Handoff / result | `node4/src/runtime/subagent-handoff.ts`, `subagent-result.ts` |
| Tool entry | `node4/src/tools/subagent.ts` |
| pi SDK | `research/pi/packages/coding-agent/src/core/sdk.ts` |
| pi session | `research/pi/packages/coding-agent/src/core/agent-session.ts` |
| pi agent loop | `research/pi/packages/agent/src/agent.ts`, `types.ts` |
| pi harness docs | `research/pi/packages/agent/docs/agent-harness.md`, `hooks.md` |

---

*End of research note for #10.*
