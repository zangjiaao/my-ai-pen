# Research: Industry context-window management for agent harnesses

**Date:** 2026-08-14  
**Scope:** What mainstream agent products do when a long run approaches or exceeds the model context window, and which *approach families* fit our Graph × Pi shape. Facts and citations only — **no product decision**.  
**Question:** When the runtime transcript grows toward the window, what is the trigger, the mechanism, what the next model turn sees vs what the UI still shows, and what happens if compact is off or fails?

**Our shape (locked, not in dispute):** Product state is SOT (Todo, findings, Graph handoff, process facts). Runtime transcript is subordinate and never fail-closed gate input. Runtime is **pi-ai + pi-agent-core** via `runNode4Agent`. **Deny** pi-coding-agent and **AgentHarness** as product Runtime. Allowed optional APIs: `transformContext` / `convertToLlm` on `Agent`. Paths: **Free parked continue** (same Agent, growing transcript), **Expert Graph** (new Agent per stage; same-stage park reuses Agent), **package worker** (own Agent; structured summary back).

**Sources:** Claude Code + Anthropic Messages compaction docs; OpenAI Codex app-server + config sample + Responses compaction guide; Cursor first-party blog + hooks + CLI changelog; xAI Compaction API + Grok Build user-guide (local first-party); `@earendil-works/pi-agent-core@0.80.2` README + `dist/harness/compaction/` + `Agent` / `AgentHarness`; OpenHands SDK Context Condenser docs; Node4 `run-node4-agent.ts` / ADR 0001 / CONTEXT.md (code and product-shape facts only).

---

## Executive answer

Mainstream coding/agent products do **not** treat an overflowing transcript as “session death.” They almost all **keep the product/UI thread**, then shrink **what the next model call sees**. The shrink is some mix of:

1. **Lossy prefix summary + keep-recent suffix** (Claude Code `/compact` + auto-compact; Grok `/compact` + 85% auto; pi-agent-core harness `compact()`; OpenHands `LLMSummarizingCondenser`; Cursor summarization).
2. **Opaque provider blob** (OpenAI `/responses/compact` + `context_management`; xAI `POST /v1/responses/compact`) — not a human-readable SOT.
3. **Externalize bulky bytes to files / memory / Product state**, then rehydrate on demand (Cursor dynamic context discovery; Grok memory flush + post-compact search; Claude Code CLAUDE.md / auto-memory / skill re-inject; our already-shipped tool-output archive).
4. **Do not grow one transcript forever** — isolate work in a **new Agent / subagent / stage** and return a **summary** (Claude / Grok / Cursor subagents; our Graph stage + package worker).

**Node4 today has no compact path.** `runNode4Agent` constructs `new Agent({…})` with **no** `transformContext` and never calls harness `compact()` / `shouldCompact`. A Free parked continue or a long same-stage Graph captain will grow `agent.state.messages` until the provider rejects the request. Overflow is therefore **fail-open to provider error**, not a designed compact. Product state (Todo / findings / handoff) already survives independently of that transcript.

A later grilling ticket can choose among the four families in **§ Approach families**. This note does **not** pick one.

---

## Our shape today (facts only)

| Fact | Source |
|------|--------|
| Product state is SOT; Runtime transcript is subordinate; never fail-closed gate input | `CONTEXT.md` (Product state / Runtime transcript); ADR 0001 §10 |
| Runtime packages: pi-ai + pi-agent-core only; **deny** pi-coding-agent, **AgentHarness**, session JSONL/memory repos as product SOT | ADR 0001 §8–§10 |
| Allowed optional APIs: `transformContext` / `convertToLlm` on `Agent` | ADR 0001 §9 |
| Seam: `runNode4Agent` → `new Agent({ initialState, streamFn, getApiKey, hooks, sessionId })` — **no** `transformContext`, **no** compact | `node4/src/runtime/run-node4-agent.ts` |
| Free parked continue: same captain Agent, next turn is `prompt(utterance)` on the parked runtime | Spec #283 / `run-parked-working-continue.ts`; Spec #455 |
| Expert Graph: `createBoundNode4Session` per stage executor attach; same-stage park reuses Agent | `hard-graph-stage-executor.ts`; CONTEXT.md User interrupt / park |
| Package worker: own Agent; parent sees structured `summary` + candidates/facts, not the child transcript | `subagent-result.ts` (`SubagentStructuredResult.summary`) |
| Tool output already bounded for the model; full archive on disk | `tool-output-governance.ts` (`MODEL_TOOL_OUTPUT_CHARS = 48_000`) |
| Session Reset = dispose Agent + mint new `sessionId` (pi `/new`); Todo kept | Spec #354 L10a; `working-session-park.ts` |

So: **isolation (Family D) is already product law** at Graph-stage and package-worker boundaries. **In-Agent transcript growth** is unsolved on Free park and on a long same-stage captain.

---

## Product comparison

### 1. Claude Code / Anthropic

| Dimension | Behavior | Source |
|-----------|----------|--------|
| **Trigger** | Auto as the conversation approaches the model window. Default: compact when the conversation **reaches the model’s context limit**, except cloud (approaches limit), 200K-held models (200K boundary), Sonnet 5 (~**967K** by default). Tunable: `/autocompact <N>`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Manual: `/compact [focus]`. | [Claude Code context window](https://code.claude.com/docs/en/context-window); [model-config — auto-compaction](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction) |
| **Mechanism (product)** | Two-step: **clear older tool outputs first**, then **summarize** the conversation if needed. `/compact` with a focus steers what the summary keeps. Persistent rules belong in `CLAUDE.md`, not early chat. Subagents get a **separate window**; only summary + small trailer return. | [How Claude Code works — When context fills up](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up) |
| **Mechanism (API, distinct)** | Messages API beta `compact-2026-01-12`: trigger default **150k input tokens** (min 50k); server writes a `compaction` content block; later requests drop everything **before** that block. Optional `pause_after_compaction`, custom `instructions`. Same model does the summary. | [Anthropic Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) |
| **Next model turn** | Structured summary + recent work. System prompt / output style unchanged (not in message history). Project-root `CLAUDE.md`, unscoped rules, auto-memory **re-injected from disk**. Path-scoped rules and nested `CLAUDE.md` **lost until a matching file is read again**. Invoked skill bodies re-injected, capped **5,000 tokens/skill and 25,000 total** (oldest dropped; truncation keeps the **start** of `SKILL.md`). | [What survives compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction) |
| **UI / disk** | Full session still written as JSONL under `~/.claude/projects/`. Resume/fork read that log. Compaction rewrites **model-visible** history, not “delete the chat.” | [How Claude Code works — Work with sessions](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions) |
| **Overflow if compact off / fails** | `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` + auto-compact **off** → session **stops at 200K** with **Prompt is too long**. `DISABLE_COMPACT` disables **all** compaction (used with custom window on recognized Claude IDs). If a single file/tool output **refills** the window after each summary, auto-compact **stops after a few attempts** (`Autocompact is thrashing…`) instead of looping. Compaction will **not** fall back to a **smaller-window** model. API compaction can return `compaction.content: null` if the summarizer calls a tool. | [model-config](https://code.claude.com/docs/en/model-config); [troubleshooting — thrashing](https://code.claude.com/docs/en/troubleshooting#auto-compaction-stops-with-a-thrashing-error); [API limitations](https://platform.claude.com/docs/en/build-with-claude/compaction) |
| **Fit / misfit Node4** | **Fit:** keep UI thread; rehydrate durable files after summary; subagent isolation matches package workers. **Misfit as copy:** Claude Code’s compact is a **coding-agent session rewrite** (JSONL + `/compact` + skill re-inject). Wiring that through **AgentHarness** or treating JSONL as SOT **violates ADR 0001**. Request-time prune via `Agent.transformContext` is the allowed analogue, not `AgentHarness.compact()`. |

### 2. OpenAI Codex

| Dimension | Behavior | Source |
|-----------|----------|--------|
| **Trigger (product)** | Manual: CLI `/compact`; app-server `thread/compact/start` (returns `{}` immediately). Auto: `model_auto_compact_token_limit` (sample comment **64000**; **unset → model defaults**). Scope: `model_auto_compact_token_limit_scope = "total" \| "body_after_prefix"` (default `total`). Per-tool stored output: `tool_output_token_limit` (sample **12000**). | [Codex app-server](https://developers.openai.com/codex/app-server); [config sample](https://developers.openai.com/codex/config-sample); [best practices](https://developers.openai.com/codex/learn/best-practices) |
| **Trigger (API)** | Server-side: `context_management: [{ type: "compaction", compact_threshold: N }]` on `POST /responses`. Standalone: `POST /responses/compact`. Both require the **current window still fit**. | [OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction) |
| **Mechanism** | History rewritten to a **bridge**: user prompts + summary (lossy). Configurable `compact_prompt` / `experimental_compact_prompt_file`. Progress streams as a `contextCompaction` item (`item/started` → `item/completed`). After compact, `SessionStart` hooks with `source: "compact"` run before the next model request (also for auto). `PreCompact` / `PostCompact` matchers: `manual` \| `auto`. Standalone compact returns a **canonical next window** (compaction item **plus retained items**) — **do not prune** that output. Server-side compact emits an **opaque** encrypted item and continues inference in the same stream. | App-server; Hooks; Compaction guide |
| **Next model turn** | Compacted window only. Injected items stay in subsequent requests. Goals (when enabled) live on the **thread**, not in the dropped prefix. | [research-codex-session-survive-interrupt.md](research-codex-session-survive-interrupt.md) (prior first-party pass); Compaction guide |
| **UI / disk** | Thread JSONL **rollout** remains (full items for `thread/read`). Compaction shrinks **model-visible** history; UI still has the thread. `thread/compacted` notification is **deprecated** in favor of the `contextCompaction` item. | App-server |
| **Overflow if compact off / fails** | Standalone compact **cannot rescue** an already-over-limit window. Product overflow copy (first-party issue title): *“Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.”* Setting `model_auto_compact_token_limit` huge disables the safety rather than offering a mid-turn opt-out. | Compaction guide; [openai/codex#18052](https://github.com/openai/codex/issues/18052) |
| **Fit / misfit Node4** | **Fit:** explicit compact RPC + auto token threshold + tool-output cap; thread id / Product state survive; compact is **not** interrupt. **Misfit:** Codex compact **is** the session-SOT rewrite (rollout + `contextCompaction`). We must not parse private Runtime/session formats for gates (ADR 0001 §10). Provider `/responses/compact` is a **Family B** option only if we stay under the window **before** the call. |

### 3. Cursor

| Dimension | Behavior | Source |
|-----------|----------|--------|
| **Trigger** | Auto when “the model’s context window fills up”; manual summarization (`/summarize`; `/compact` and `/compress` are aliases). `preCompact` hook payload documents `trigger: "auto" \| "manual"` and an **example** `context_usage_percent: 85` — that 85 is the **schema example**, not a published default threshold. | [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) (2026-01-06); [Hooks — preCompact](https://cursor.com/docs/hooks#precompact); [CLI changelog 2026-05-20](https://cursor.com/docs/cli/changelog) |
| **Mechanism** | Summarization gives the agent a **fresh window + summary**. Distinct Cursor bet: **dynamic context discovery** — long tool/MCP/shell output is written to **files** (agent `tail`s / reads) instead of truncated in-prompt; chat history is a **file the summarizer and later turns can search**; MCP tool bodies live in per-server folders (names stay static); terminals synced as files. Subagents (e.g. Explore) keep raw search out of the parent. | Cursor blog; [Subagents](https://cursor.com/docs/subagents) |
| **Next model turn** | Summary + ability to **re-read history / tool files** if the summary dropped a detail. Skills stay progressive (name/description static; body on demand). | Blog |
| **UI / disk** | Chat timeline and checkpoints (file snapshots) remain. `preCompact` is **observational** — cannot block or change compact; may set `user_message` for the UI. Local agents persist conversation in a checkpoint store (SDK). | Hooks; [TypeScript SDK](https://cursor.com/docs/sdk/typescript) |
| **Overflow if compact off / fails** | First-party: **conversation summarization fails closed for no-storage teams** (privacy). Official docs do **not** publish a “compact off → provider 400” matrix beyond that fail-closed and the usual window limit. | CLI changelog |
| **Fit / misfit Node4** | **Fit (strong):** “history/tool output as files + Product state SOT” matches our already-shipped output archive and the ADR “transcript is not SOT” law. Subagent isolation matches workers. **Misfit:** Cursor’s summarizer is still a **coding-agent chat rewrite**; we must not import their session store. `preCompact` as UI notice is optional chrome, not a gate. |

### 4. Grok Build / xAI

Two layers: **Grok Build product compact** (first-party user guide) and **xAI Responses Compaction API** (provider blob).

#### 4a. Grok Build (agent product)

| Dimension | Behavior | Source |
|-----------|----------|--------|
| **Trigger** | Manual `/compact [context]`. Auto when usage hits **`[session] auto_compact_threshold_percent`** (default **85**) of the model’s `context_window`. Custom models: inherit known window or default **200,000** if omitted. Notification on auto. Headless: `system` / `subtype: "compact_boundary"`; also `auto_compact_*` events. ACP: `compact_conversation`. | `~/.grok/docs/user-guide/04-slash-commands.md`, `05-configuration.md`, `11-custom-models.md`, `14-headless-mode.md`, `15-agent-mode.md`, `17-sessions.md` |
| **Mechanism** | Compress conversation history; optional focus string. **Before** compact: memory **flush** (`[compaction.memory_flush]`, default on; soft headroom **4000** tokens). **Alongside:** tool-result **pruning** (`[compaction.pruning]`: keep last **3** turns intact; soft-trim old results at **4000** chars to head **1500** + tail **1500**; hard-clear to placeholder after **10** turns). Opt-in `two_pass_compaction`. Plan mode: plan state **preserved**; compacted context includes a plan-mode reminder. `PreCompact` / `PostCompact` hooks (`manual` \| `auto`); observational. Subagents: **own window**, summary back. | `13-memory.md`, `19-plan-mode.md`, `10-hooks.md`, `16-subagents.md` |
| **Next model turn** | Compacted chat + re-injected memory search (“after auto-compaction to recover relevant context that may have been discarded”). Plan reminder if plan mode was on. | `13-memory.md`, `19-plan-mode.md` |
| **UI / disk** | Session dir keeps `updates.jsonl` (authoritative restore log), `chat_history.jsonl`, `plan.json`, and **`compaction_checkpoints/`** (manual or auto). `/resume` restores from `updates.jsonl`. Compaction **discards old conversation turns** from the **model** window; checkpoints exist so restore is not “summary only.” | `17-sessions.md` |
| **Overflow** | Guide: auto-compact “when the context window **approaches** its limit.” Changelog (product): compaction **handles certain context-length errors**; large paste no longer breaks compact + memory flush. User guide does **not** document a fail-closed “compact off” path; `/new` is the wipe. | `17-sessions.md`; [Grok Build changelog](https://x.ai/build/changelog) |

#### 4b. xAI Compaction API (provider)

| Dimension | Behavior | Source |
|-----------|----------|--------|
| **Trigger** | Caller decides (every N turns, or when rendered context crosses a **workload-chosen** threshold). Not an automatic server loop unless the client calls it. | [Context Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction) |
| **Mechanism** | `POST /v1/responses/compact` → one `compaction` item with **opaque `encrypted_content`**. Client **drops** original messages and appends new user turns **after** the blob. `chat.compact()` does this in-place. Re-compact of an already-compacted conversation is allowed. At most **one pass per call**. | same |
| **Next model turn** | Server rehydrates the blob. Not human-readable. `use_encrypted_content=True` recommended so prior reasoning survives. | same |
| **Overflow** | **“Compaction shrinks the conversation; it cannot rescue a request that is already over the limit.”** Caller must prune/split first. | same |
| **Fit / misfit Node4** | **Grok Build product compact** is Family A + C (prune tools, flush memory, keep session files) — closest peer to a **long Free park**. **xAI API blob** is Family B: useful only as a **provider trick** under the window; the blob must **not** become Product SOT or a gate input. Subagent isolation already matches our workers. |

### 5. pi-agent-core (dependency `0.80.2`) — offer vs ADR allow

Package source: `/mnt/d/Coding/my-ai-pen/node4/node_modules/@earendil-works/pi-agent-core/` (README + `dist/`). Repo: [earendil-works/pi](https://github.com/earendil-works/pi) `packages/agent`.

#### What the package offers

| API | Where | What it does |
|-----|--------|----------------|
| `Agent.transformContext` | `Agent` / `agentLoop` | **Request-time** `AgentMessage[] → AgentMessage[]` immediately before `convertToLlm`. Does **not** write back to `agent.state.messages` (`agent-loop.js` uses a local `messages` binding). README: “Prune old messages, inject external context.” |
| `Agent.convertToLlm` | same | Filter/convert to provider `Message[]`. Required for custom roles. |
| `shouldCompact(tokens, window, settings)` | `harness/compaction/compaction.js` | If `settings.enabled` and `contextTokens > contextWindow - reserveTokens`. **Default** `DEFAULT_COMPACTION_SETTINGS`: `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`. |
| `estimateContextTokens` / `calculateContextTokens` | same | Last assistant `usage` + heuristic trailing (≈ chars/4). |
| `generateSummary` | same | Separate LLM call (`completeSimple`) with a **fixed structured** prompt: Goal / Constraints / Progress (Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context. Optional `customInstructions` and iterative update from `previousSummary`. Max tokens = `min(0.8 * reserveTokens, model.maxTokens)`. |
| `prepareCompaction` / `findCutPoint` / `compact` | same | Walk **session tree entries** (not raw `Agent.messages`). Keep ~20k recent tokens; cut only at valid roles (not mid-`toolResult`). Split-turn: extra prefix summary. Appends read/modified file lists. |
| `AgentHarness.compact(customInstructions?)` | `harness/agent-harness.js` | **Idle-only.** `prepareCompaction` + `compact` (or hook-provided result) → `session.appendCompaction(...)`. Emits `session_before_compact` / `session_compact`. |
| `buildSessionContext` | `harness/session/session.js` | After a compaction entry: model context = **one `compactionSummary` message** + entries from `firstKeptEntryId` onward. Full tree still on disk. |
| Auto-trigger | **not in Agent / AgentHarness** | `shouldCompact` is an **exported helper**. `AgentHarness` does **not** call it on turn boundaries. README’s `shouldStopAfterTurn` example is **caller-owned**. Auto-compact in the wild lives in **pi-coding-agent** (denied). |

`transformContext` on `AgentHarness` is a `context` hook that can replace the message list for the **next LLM call** — still harness-owned.

#### What ADR 0001 allows us to call

| Surface | ADR | Implication |
|---------|-----|-------------|
| `new Agent({ transformContext, convertToLlm, … })` | **Allow** | Request-time prune / inject / Product-state rehydrate **without** mutating stored transcript or using harness session files. |
| `shouldCompact` / `estimateContextTokens` **as pure functions** | Not named. They are **harness compaction helpers**, not `Agent` APIs. | Importing the functions is mechanically possible; using them to **drive AgentHarness.compact()** is the denied path. A grilling ticket can treat “call the helper, then apply the result via `transformContext` or by rewriting `agent.state.messages`” as a **construction** choice. |
| `generateSummary` / `compact` / `prepareCompaction` | Same helpers; `compact` is built around **SessionTreeEntry[]** | Tightly coupled to harness session trees (denied as product SOT). Reusing the **prompt shape** is not the same as calling `AgentHarness`. |
| `AgentHarness`, JSONL/memory session repos, `AgentHarness.compact()` | **Deny** as product Runtime | Do not make compact a coding-agent session rewrite. |
| Node4 today | — | **Neither** allow-list hook is wired. Growing `state.messages` is the only behavior. |

**Overflow in the package:** if `shouldCompact` is never called (our case), the next `streamSimple` is an over-limit provider error. `generateSummary` / `compact` themselves **must fit** the summarizer window (`reserveTokens` budget). There is no package-level “rescue an already overflowing Agent.messages.”

### 6. OpenHands (additional coding agent — primary SDK docs)

| Dimension | Behavior | Source |
|-----------|----------|--------|
| **Trigger** | `LLMSummarizingCondenser(max_size=…, keep_first=…)`. Official example: condense when history has **more than `max_size` events** (example **10**), always keep the first **`keep_first`** events (example **2** = system + initial user). | [OpenHands Context Condenser](https://docs.openhands.dev/sdk/guides/context-condenser) |
| **Mechanism** | Rolling condenser: recent events intact; older events **replaced by an LLM summary**. Extensible via `RollingCondenser` / `CondenserBase`. Attached on `Agent(..., condenser=condenser)`. | same; [source tree](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/) |
| **Next model turn** | `keep_first` + summary + recent tail. Conversation object can be serialized / deserialized from `persistence_dir` and continue. | same example |
| **UI / disk** | Persistence dir holds the conversation; condensation changes what is converted to LLM messages (`LLMConvertibleEvent`), not necessarily the operator’s event log. | same |
| **Overflow** | Docs describe **proactive** event-count condensation so the history “stays within a specified size limit.” They do **not** document a separate fail-closed path when the condenser is omitted — the example’s point is that without it, cost/latency/effectiveness degrade. | same |
| **Fit / misfit Node4** | **Fit:** condenser is a **pluggable policy on the Agent**, conceptually closer to `transformContext` than to AgentHarness session trees. Event-count trigger is crude vs token %. **Misfit:** OpenHands condenser is still **transcript-SOT** (it rewrites the rolling history the agent owns). Our Product state must stay outside that rewrite. |

---

## Cross-cut

### Trigger families actually used

| Trigger | Who |
|---------|-----|
| Token % of window | Grok **85%**; Cursor hook **example** 85%; Claude “approaches / reaches limit” (per-model defaults, e.g. Sonnet 5 ~967K) |
| Absolute token reserve | pi-agent-core `window - 16384`; Codex `model_auto_compact_token_limit` (model default or config) |
| Event / message count | OpenHands `max_size` |
| Manual slash / RPC | `/compact`, `/summarize`, `thread/compact/start`, `compact_conversation`, `AgentHarness.compact()` |
| Provider-side threshold | Anthropic `trigger.input_tokens` (default 150k); OpenAI `compact_threshold` |
| Provider error (recovery) | Grok changelog “handles certain context-length errors”; Claude unknown-model `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` waits for API too-long |
| Never (today) | **Node4 `runNode4Agent`** |

### What the next model turn sees vs UI

Consensus: **UI/thread/session files stay**; **model prefix is replaced**. Durable extra state is re-injected from **disk / Product state / files**, not from the dropped transcript:

| Durable rehydrate | Who |
|-------------------|-----|
| CLAUDE.md / auto-memory / skill bodies | Claude Code |
| Thread rollout + goals | Codex |
| History + tool files the agent can search | Cursor |
| Memory search + plan.json + checkpoints | Grok |
| Session tree still on disk; model sees `compactionSummary` + tail | pi-agent-core harness |
| Todo / findings / Graph handoff / process facts | **Node4 Product state (already)** |

### Overflow if compact is off or fails

| Product | Off / fail behavior |
|---------|---------------------|
| Claude Code | Prompt too long; or **thrashing stop** after repeated refill; no smaller-window fallback for the summarizer |
| Anthropic API | Compaction block `content: null` if summarizer tool-calls; conversation you compact must be valid |
| Codex / OpenAI | Must compact **before** overflow; else “start a new thread or clear earlier history” |
| xAI API | Cannot rescue over-limit; prune/split first |
| Cursor | Summarization **fail-closed** for no-storage teams |
| Grok Build | Auto at 85%; changelog recovers some context-length errors; `/new` wipes |
| pi-agent-core | No auto; provider error. `compact()` throws if idle-not / nothing-to-compact / summarizer abort |
| Node4 today | Provider error on the live Agent. Park/Product state remain. No designed wrap-up. |

### Fit to our three paths

| Path | Transcript shape today | Pressure |
|------|------------------------|----------|
| **Free parked continue** | Same `Agent`, `prompt(utterance)` appends. Transcript **grows without bound**. | Highest. This is the Claude/Grok/Codex “one long chat” problem. |
| **Expert Graph captain** | New Agent **per stage**; same-stage park **reuses** Agent. | Medium. Stage boundaries already implement Family D. A **long stage** (many packages, many continues) is the same as Free park. |
| **Package worker** | Own Agent; parent gets `SubagentStructuredResult.summary` (+ structured fields). Child disposed. | Lowest for the **parent**. Child can still overflow **inside** one wave if tools are huge — already mitigated by `tool-output-governance`. |

Nothing in the industry survey requires making the Runtime transcript a gate input. Several peers **explicitly** keep UI/disk history while shrinking only the model view — that is compatible with “transcript is subordinate.”

---

## Approach families (for a later grilling ticket)

Do **not** treat these as a ranked recommendation. They are the clusters a grill can choose among (or combine). All four appear in first-party sources above.

### Family A — Prefix-summarize + keep-recent (lossy model view)

**What:** At a token/event threshold (or `/compact`), run a summarizer over the **prefix**, keep a **recent suffix**, optionally prune old tool results first.

**Peers:** Claude Code auto + `/compact`; Grok `/compact` + pruning; Codex `/compact` + auto token limit; pi-agent-core `generateSummary` / `compact` / `keepRecentTokens`; OpenHands `LLMSummarizingCondenser`.

**Survives for the model:** structured summary + last N tokens/turns.  
**Survives for UI:** the chat/session files (usually).  
**Overflow:** must fire **before** the window is full; thrashing/over-limit → stop and ask the user to `/clear` or new thread.

**Node4 mapping (construction, not a decision):** implement behind **`Agent.transformContext`** (allowed) and/or an idle rewrite of `agent.state.messages`. **Do not** call `AgentHarness.compact()` or persist harness JSONL as SOT. Summary text is **not** Product state and **must not** be a Feedback gate.

**Tension with our shape:** Free park and long same-stage captains are the only places this family is *necessary*. Graph stage + worker already reset the Agent.

### Family B — Provider opaque compact (encrypted blob)

**What:** Call the model vendor’s compact endpoint; replace client-side messages with an **opaque** item the **same vendor** rehydrates.

**Peers:** OpenAI `context_management` / `/responses/compact`; xAI `/v1/responses/compact`; Anthropic Messages `compaction` block (readable summary, but still a provider content-block contract).

**Survives for the model:** whatever the vendor packed.  
**Survives for UI:** whatever we kept locally — the blob is not a UI document.  
**Overflow:** **all three vendors say the request must still fit.** This is not an after-the-fact rescue.

**Node4 mapping:** optional **pi-ai / provider** concern, not a Product-state concern. Fits only if we detect pressure **early** and only for providers that offer it. The blob **must not** be parsed for gates (ADR 0001). Multi-provider Node4 (`resolveNode4Model`) cannot assume one vendor.

**Tension:** locks compact quality to the active provider; useless on a gateway that does not implement the beta; still needs a Family A/C fallback.

### Family C — Externalize + rehydrate (transcript never SOT)

**What:** Do not keep bulky tool output / old turns in the model window. Write them to **files / memory / Product state**. After any summary (or instead of one), the next turn **re-reads** Todo, findings, Graph handoff, archived tool output, skills.

**Peers:** Cursor dynamic context discovery (tool/history/MCP/terminal as files); Grok memory flush + post-compact search; Claude Code disk re-inject of CLAUDE.md / memory / skills; our `tool-output-governance` archive; our Product state already.

**Survives for the model:** small working set + pointers (“full archive on disk”, Store ids, handoff).  
**Survives for UI:** Product panels (Tasks, Findings, Surface) — already the operator SOT.

**Overflow:** a missed rehydrate is **amnesia**, not a gate fail. Compatible with “transcript never fail-closed.”

**Node4 mapping:** closest to **already-accepted law**. A grill can decide how aggressively `transformContext` **drops** old `toolResult`s (Grok-style prune) and **injects** a Product-state brief (handoff / open todos / findings), without calling harness compact.

**Tension:** without *some* A-like summary, a 200-turn Free park still burns tokens on old **assistant text** even if tools are archived. Family C alone may need a thin A.

### Family D — Fresh Agent per work unit (already our Graph/worker shape)

**What:** Do not compact the parent. **Start a new Agent** (new `sessionId`) per stage / package / wave. Child returns a **structured summary**. Parent transcript stays short.

**Peers:** Claude / Grok / Cursor **subagents** (own window, summary back). Codex collaborator threads. Our Expert Graph stage executor + package worker.

**Survives for the model (parent):** the child’s `summary` + structured fields only.  
**Survives for UI:** Worker audit / Tasks / Findings — Product state.

**Overflow:** moved to the **child**. Child still needs A/C if one wave is huge; parent does not.

**Node4 mapping:** **already shipped** for Graph stages and workers. **Not** shipped as the answer to **Free parked continue** or **same-stage captain park** (those *reuse* the Agent by spec — #283 / #455). Using D on Free continue would mean dispose+reseed on pressure, which is the opposite of park-hit “same runtime.”

**Tension:** D does not remove the need for A/B/C on the **long-lived captain**.

---

## What a grilling ticket can decide (not decided here)

A later grill can pick a **combination**, not a single family. Questions the sources actually support asking:

1. On **Free parked continue** and **same-stage Graph park**, do we keep one Agent and shrink its **model view** (A and/or C via `transformContext`), or treat pressure as park-miss / Reset-class reseed (D)?
2. Is provider compact (B) allowed as an **optional acceleration** when the active model exposes `/responses/compact` or Anthropic `compaction` blocks — never as SOT?
3. May Node4 import pi-agent-core **`shouldCompact` / `generateSummary` as functions**, or only reimplement the *policy* (threshold + summary prompt) in product glue so we never touch harness session trees?
4. If compact fails or is off: **surface the provider error** (today), **thrash-stop like Claude**, or **force a Product-state reseed** (Reset-like, Todo kept)?

Out of scope for that grill unless reopened: using **AgentHarness** or session JSONL as product SOT (ADR 0001 already forbids).

---

## Quick reference matrix

| Product | Trigger | Mechanism | Model sees next | UI / disk | Overflow | Node4 fit |
|---------|---------|-----------|-----------------|-----------|----------|-----------|
| Claude Code | Approach/limit; `/compact`; tunable window | Tool-output clear → summary; disk re-inject | Summary + recent; CLAUDE.md/memory/skills | JSONL kept | Prompt too long / thrash stop | A+C+D; not AgentHarness |
| Anthropic API | 150k input default | Server `compaction` block | Summary block onward | Client history optional | Must fit; tool-call can null the block | B |
| Codex | Token limit / `/compact` / `thread/compact/start` | Bridge summary; opaque server compact | Compacted window | Rollout kept | New thread / clear | A+B; session format not SOT |
| Cursor | Window full / `/summarize` | Summary + **files** for history/tools | Summary + file search | Chat + checkpoints | Fail-closed if no-storage | **C** strongest peer |
| Grok Build | **85%** / `/compact` | Summary + prune tools + memory flush | Compact + memory + plan | `updates.jsonl` + checkpoints | Some context-length recovery | A+C; long Free park peer |
| xAI API | Client-chosen | Opaque `encrypted_content` | Rehydrated blob | N/A | Cannot rescue over-limit | B only |
| pi-agent-core | Helper only (`window − 16k`) | Harness session compact **or** `transformContext` | `compactionSummary` + tail | Session tree if harness | Provider error if unused | **transformContext allowed**; harness compact denied |
| OpenHands | Event `max_size` | LLM summary of dropped events | keep_first + summary + tail | persistence_dir | Not specified off-path | A on Agent |
| **Node4 today** | **None** | Growing `Agent.messages` | Full transcript | Product state + UI | Provider error | D at stage/worker only |

---

## Source index

| Source | Role |
|--------|------|
| [Claude Code — Explore the context window](https://code.claude.com/docs/en/context-window) | What survives `/compact`; auto-compact; subagent isolation |
| [Claude Code — How it works § When context fills up](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up) | Tool-output clear then summarize; thrash pointer; CLAUDE.md |
| [Claude Code — model-config auto-compaction](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction) | Defaults, `/autocompact`, 200K hold, `DISABLE_COMPACT` |
| [Claude Code — troubleshooting thrashing](https://code.claude.com/docs/en/troubleshooting#auto-compaction-stops-with-a-thrashing-error) | Stop after refill loop |
| [Anthropic — Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) | Server-side `compact-2026-01-12`, 150k trigger, limitations |
| [Codex app-server](https://developers.openai.com/codex/app-server) | `thread/compact/start`, `contextCompaction` item |
| [Codex config sample](https://developers.openai.com/codex/config-sample) | `model_auto_compact_token_limit`, scope, `tool_output_token_limit`, `compact_prompt` |
| [OpenAI — Compaction](https://developers.openai.com/api/docs/guides/compaction) | Server-side threshold + standalone `/responses/compact`; must fit |
| [Codex hooks](https://developers.openai.com/codex/hooks) | `PreCompact`/`PostCompact`; `SessionStart` `source: compact` |
| [openai/codex#18052](https://github.com/openai/codex/issues/18052) | First-party overflow copy |
| [Cursor — Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) | Files for tools/history/MCP; summarization + re-search |
| [Cursor hooks — preCompact](https://cursor.com/docs/hooks#precompact) | auto/manual; observational; example 85% |
| [Cursor CLI changelog](https://cursor.com/docs/cli/changelog) | `/summarize`; fail-closed no-storage |
| [xAI — Context Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction) | Opaque blob; cannot rescue over-limit |
| `~/.grok/docs/user-guide/04-slash-commands.md`, `05-configuration.md`, `13-memory.md`, `17-sessions.md` | Grok `/compact`, 85%, flush, prune, checkpoints |
| `@earendil-works/pi-agent-core@0.80.2` README + `dist/harness/compaction/compaction.js` + `agent-harness.js` + `session/session.js` | `transformContext`, `shouldCompact`, `generateSummary`, `compact`, harness-only auto-gap |
| ADR 0001; `CONTEXT.md`; `node4/src/runtime/run-node4-agent.ts` | Allow/deny surface; Node4 wires neither compact nor `transformContext` |
| [OpenHands Context Condenser](https://docs.openhands.dev/sdk/guides/context-condenser) | `LLMSummarizingCondenser` max_size / keep_first |

---

*Living research note for a later grilling ticket. Not product authority; does not change `docs/specs/harness.md` or ADR 0001.*
