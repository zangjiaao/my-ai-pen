# Spec: Layered system-prompt assembly

**Status:** Living Spec — **P1–P4 shipped** (T1–T6 / [#387](https://github.com/zangjiaao/my-ai-pen/issues/387)–[#392](https://github.com/zangjiaao/my-ai-pen/issues/392); follow-ups [#393](https://github.com/zangjiaao/my-ai-pen/issues/393)–[#395](https://github.com/zangjiaao/my-ai-pen/issues/395), de-dupe [#396](https://github.com/zangjiaao/my-ai-pen/issues/396)–[#399](https://github.com/zangjiaao/my-ai-pen/issues/399), pack quality [#402](https://github.com/zangjiaao/my-ai-pen/issues/402)–[#405](https://github.com/zangjiaao/my-ai-pen/issues/405)). Parent Spec [#386](https://github.com/zangjiaao/my-ai-pen/issues/386) closable. Four-layer model remains **normative**; edit this Spec when layer ownership or path recipes change.  
**Issue:** [#386](https://github.com/zangjiaao/my-ai-pen/issues/386)  
**Implementation tickets (sub-issues of #386):**  
[#387](https://github.com/zangjiaao/my-ai-pen/issues/387) T1 assembler + Default/Free parity ·  
[#388](https://github.com/zangjiaao/my-ai-pen/issues/388) T2 Free Runtime thin ·  
[#389](https://github.com/zangjiaao/my-ai-pen/issues/389) T3 slim Profession core ·  
[#390](https://github.com/zangjiaao/my-ai-pen/issues/390) T4 Graph stage seam ·  
[#391](https://github.com/zangjiaao/my-ai-pen/issues/391) T5 Package worker seam ·  
[#392](https://github.com/zangjiaao/my-ai-pen/issues/392) T6 docs closeout  
**Amended:** 4-layer model (Base / Profession / Runtime / Task) — owner: prefer fewer layers with clear duty over L0–L5 fine split  
**Product path:** Graph × Pi + Node4 (ADR 0001). Soft scenario Graph remains **retired**.  
**Does not amend:** Participant Session work-mode authority (#277 / #278 / #284), Finding Store / book-path L0, surface ledger SoT, Feedback L0/L1 algorithms, intent NLP ban (`AGENTS.md`).  
**Aligns with:** progressive skill disclosure (#274 Wave 2), Graph L1 catalog (#278), host-owned stage settlement, Standing-first language (#352).

### Shipped (P1–P3 / T1–T5)

| Ticket | Phase | Landed |
|--------|-------|--------|
| [#387](https://github.com/zangjiaao/my-ai-pen/issues/387) T1 | **P1** | Public `assembleSystemPrompt` seam; Default Main + Expert Free Main via four layers (Standing-first Base → Profession → Runtime → Task) |
| [#388](https://github.com/zangjiaao/my-ai-pen/issues/388) T2 | **P2** | Free Runtime thin; Graph process/settlement longform out of Free always-on; Graph L1 catalog only in Runtime when present |
| [#389](https://github.com/zangjiaao/my-ai-pen/issues/389) T3 | **P2** | Slim Expert Profession core (pentest `mission.md` / `work.md`); citizen/handoff not re-owned in pack how-to (host inject; see §3.3.1) |
| [#390](https://github.com/zangjiaao/my-ai-pen/issues/390) T4 | **P3** | Expert Graph stage captains on the same seam + Profession core/compact markers |
| [#391](https://github.com/zangjiaao/my-ai-pen/issues/391) T5 | **P3** | Package workers on the same seam (compact Profession + optional one skill body + return contract) |
| [#392](https://github.com/zangjiaao/my-ai-pen/issues/392) T6 | **P4** | **Shipped:** Spec status, pack authoring discoverability (§10 / §10.1 + `experts/README.md`), README index |

**Primary code seam:** `node4/src/runtime/prompt-layers.ts` (re-exported from `prompt.ts`) — `assembleSystemPrompt`, narrow `buildBaseLayer` / `buildProfessionLayer`, Free `buildPromptLayers`, Graph stage `buildStagePromptLayers` / `stageSystemPrompt`, Package worker `buildSubagentPromptLayers` / `buildSubagentSystemPrompt`. Hard Graph executor and subagent session **call** the seam only (no large prompt-string ownership; no fake TaskEnvelope/RolePack for workers — #393). **#394 follow-up:** Graph stage uses `buildCompactProfessionLayer` (marker-bearing mission/work subset; Free stays full Profession); hypothesis queue injection is **Runtime-only** when hyp mode is on (no Task dual-home); `RolePack.packRoot` is typed (no anonymous cast at recipe/hard-resolve paths). **#395 follow-up (Spec-honest partial):** citizen remains pack-load–prepended into mission lines (Profession string today); full RoE instance (`formatRoeInjection`) remains Free Runtime — see §3.3.1. Contract suites: `prompt-layers.test.ts`, Free/Default path contracts, `hard-graph-stage-prompts.test.ts`, `subagent-language.test.ts`.

---

## 1. Purpose

Make system prompts for **Default**, **Expert Free**, **Expert Graph** stage captains, and **Package** workers:

> **Four clear layers, one assembly seam, short always-on text** — easy to manage; encyclopedia lives in skills, not the system prompt.

Kill the failure modes where:

1. Free Main / Graph stage / Package subagent maintain **three prompt dialects**.  
2. Expert Graph stages **drop profession methodology** while workers carry full pack how-to.  
3. Pack how-to grows into a **god file** mixing citizenship, profession, Free mode, and Graph law.  
4. Layer taxonomies are too fine (six IDs) so authors do not know where a sentence belongs.  
5. Always-on prompts stay fat with Graph law and skill encyclopedias that should load on demand.

---

## 1.5 Locked assembly (normative)

This section is the placement law. Edit it when order or homes change. Do not invent a fifth system layer. Do not put the same sentence in two channels.

Learned from pi-coding-agent (`research/pi/packages/coding-agent/src/core/system-prompt.ts`): **identity and guidelines stay short and stable; tools are a one-line index (schemas are a parallel channel); project/case facts are a labeled block; skills are an index until loaded; date/cwd-class facts come last; the user turn is the operator’s words.** Their default system is: identity → available tools (snippets) → guidelines → optional append → `<project_context>` files → skills index → current date + cwd. Slash templates expand into the **user** turn, not system.

### Channels (do not mix)

| Channel | What the model sees | Put here | Never put here |
|---------|---------------------|----------|----------------|
| **System** | Four layers, one string, Standing-first | Policy, how this seat works, this-run switches, this-turn facts | Operator utterance; skill encyclopedia; tool JSON schema |
| **User turn** | Operator utterance only (`task.instruction`) | What the user typed (or a slash-template expansion of that) | Case inject, Todo reminder, work-mode, RoE, Target/Scope, outer continue |
| **Harness** | Product `role=harness`; provider maps to user + `## Runtime` (`convertNode4MessagesToLlm`) | Outer continue / goal / budget; occupancy persist-pass and checkpoint; **unread Case speech from others** (`### Case speech`) | Operator utterance; this Session’s own speech; always-on policy |
| **Tool result** | Appended tool text | Mid-run todo / booking / surface nudges (`### This-run …`) | Operator utterance |
| **Tool definitions** | Name + description + parameters (parallel to text) | How to call the tool | Policy essays, start-order, Case facts |
| **Skill body** | After `skill(get)` / worker load | Attack-class procedure | Always-on Profession; Graph settlement law |

Harness is a **channel**, not a fifth system layer. Park continue and cold Free share the same user-turn law: **utterance only**. System is not rebuilt on park-hit. Lab outer continue uses `session.prompt(..., { channel: "harness" })`, never a fake user turn.

### System order (fixed)

```text
[system]
  Base            Standing language → pack id/label → persona (display-only)
  ## Profession   citizen (today) + mission.md + work.md
  ## Runtime      tools / skill ids / work-mode / RoE / optional todo·booking reminders
  ## This turn    ### Case (markdown lists) → Engagement (target/scope/instruction as bullets) → goals
[harness]         ## Runtime / ### Continue  (outer continue, persist-pass, checkpoint)
                  ### Case speech            (unread others only — cursor, not a 123+1234 dump)
[user]
  <operator utterance>
```

Empty layers omit. **Order never rearranges.** `#352`: the first bytes of system (and of Base) are `## Standing node policies`. Later layers get a visible `## Profession` / `## Runtime` / `## This turn` fence so blocks do not bleed. The fourth layer’s **code/spec name remains Task** (this-turn facts). The Agent-visible heading is **This turn** so it is not read as the product Task/package (#455 Session-first). Case is the work group; it is not contained by a Task package.

Assembler: `assembleSystemPrompt` in `node4/src/runtime/prompt-layers.ts`. Cold Free wires this via `session-runner` `buildSystemPrompt`; user turn is `task.instruction`. Graph stage / Package workers use the same assembler (`buildStagePromptLayers` / `buildSubagentPromptLayers`).

### Where a new sentence goes

Ask one question; put the sentence in **exactly one** home.

| If the sentence is… | Home |
|---------------------|------|
| True for every product Agent (language, persona label is untrusted) | **Base** |
| True for every citizen on a Case (ledger honesty, priors = index, handoff / next_steps, no invent Hosts) | **Citizen** — duty is Base; string today prepends Profession (`mergePlatformCitizenMission`). Do not copy into `work.md` |
| How *this seat* works (start order, proof bar, deadend, fact vs finding) | **Profession** `mission.md` (identity) / `work.md` (hard rules, keep slim) |
| Procedure for one attack class or recon entry | **Skill body** — load on demand |
| True only because of *this run* (Free vs Graph, tool list, skill ids, RoE flags, cold todo/booking reminder, chat-only seat vs no-target) | **Runtime** |
| True only for *this turn* (Case 活情报 / prior catalog, Target, Scope, Instruction, session title, process-fact index, goals) | **Task** |
| Authorized handoff card body (`proposed_action`) | **Task `### Handoff`** — not the user turn; not Instruction |
| What the human just said | **User turn** |
| Lab outer continue / occupancy persist or checkpoint (not the operator) | **Harness** (`### Continue` / `### Context window` / `### Checkpoint rehydrate`) |
| Unread Case group speech from other Sessions / the operator (not self, not this-turn user) | **Harness** `### Case speech` (delta after Session cursor) |
| Mid-run todo / booking / surface nudge after a tool | **Tool result** (`### This-run todo` / `### This-run booking` / `### Surface`) |
| How to invoke a tool | **Tool schema** |

### Pollution rules

- **One home.** If citizen already says it, do not restate in `work.md`, Runtime one-liners, and the user turn.
- **Facts last in system, not first in user.** Case / Target / Scope stay in Task. User is not a second Case dump.
- **Reminders are Runtime, not user.** `eagerTodo` / `eagerBooking` / chat-only “no target” are opted-in system Runtime (`BuildSystemPromptOptions`). They render as markdown (`### This-run todo` / `### This-run booking`). Runtime work-mode, graph catalog, and RoE use `### Work mode` / `### Available graphs` / `### Rules of engagement`. Goal inject in This turn uses `### Goal`. Chat-only “named vs empty” follows structured Target/Scope content (host-only URLs and default `:80`/`:443` count as named), not an explicit non-default port. Outer continue / goal / budget use the **Harness** channel (`### Continue`, `session.prompt(..., { channel: "harness" })`). Mid-run nudges append to the **tool result** with the same `###` headings. Do not wrap harness in XML. Do not put harness in the user turn.
- **Case speech is harness, not system Thread.** Case `messages` is the append-only group log (visible talk only). Each Main / park turn injects **unread others** after the Session cursor (`speechCursor` on the parked runtime). Do not re-dump 1–3 then 1–4. Do not put `### Thread` back in This turn. Thinking and tool process stay Session-private.
- **No encyclopedia in always-on.** Graph settlement, package `plan_node_id` law, and class playbooks stay out of Free Profession.
- **Skill ids ≠ skill bodies.** Runtime lists ids; bodies enter only via `skill` / worker load.
- **Do not invent a sixth layer** for “environment.” Environment = Task (Case + target) + RoE (Runtime).

---

## 2. Vocabulary

| Term | Definition |
|------|------------|
| **Layer** | One of four ordered blocks with a **single ownership question** (see §3). |
| **Base（底座）** | Shared product + node policy: language Standing, persona label policy; **conceptual** home for platform citizen + RoE shell (see §3.3.1 for where strings live today). |
| **Profession（专业）** | Seat how-to: Default assistant **or** Expert profession **core** (sibling seats; not Default ⊂ Expert). |
| **Runtime（运行）** | This run’s harness + capability surface: Free **or** Graph stage (mutually exclusive), tools, skill ids/L1, gated tool one-liners. |
| **Task（任务）** | This-turn facts: target/scope/instruction, Case context, process facts, goals, stage handoff snapshot. |
| **Assembler seam** | Single product facade: structured layer inputs → one system prompt string for Agent Runtime. |
| **Profession core** | Short Expert (or Default) always-on how-to. Not Graph settlement encyclopedia; not skill bodies. |
| **Compact profession** | Approved shorter profession core for Graph stages / Package workers; must still satisfy §6 contract markers. |

**Existing terms (do not redefine):** Default, Expert, Work mode Free, Expert Graph / Hard Graph, Package, Participant Session, Product state, Skill L1/L2, Graph L1 catalog, RoE — see `CONTEXT.md` and related Specs.

### 2.1 Historical L0–L5 map (migration only)

Earlier drafts used six IDs. **Normative model is four layers.** Map for inventory/PRs:

| Old | New home |
|-----|----------|
| L0 Standing + L1 Platform citizen + always-on RoE | **Base** (conceptual; citizen string may still render via Profession until Option A — §3.3.1) |
| L2 Profession | **Profession** |
| L3 Work mode + L4 Capability surface | **Runtime** |
| L5 Task envelope | **Task** |

Do not reintroduce L0–L5 as product vocabulary in new code or docs.

---

## 3. Normative four-layer model

### 3.1 Order (fixed)

See **§1.5** (locked assembly). Same four layers; Standing-first; later layers fenced with `## Profession` / `## Runtime` / `## This turn`.

### 3.2 One question per layer (management rule)

| Layer | Decision question | If yes → edit this layer |
|-------|-------------------|---------------------------|
| **Base** | Is this true for every product citizen Agent on a Case? | Shared policy / ledger honesty / RoE shell |
| **Profession** | Is this how *this seat* works when it is doing its job? | Default vs pentest (etc.) core only |
| **Runtime** | Is this true only because of *this run’s* Free/Graph/tools/skills? | Mode block, tool list, catalogs |
| **Task** | Is this *this turn’s* target, instruction, or injected facts? | Envelope / case / handoff |

**Attack-class procedure depth** is never a fourth “layer” in system prompt — it is **skill body** (progressive load).

### 3.3 Ownership table

| Layer | Owns (conceptual duty) | Must not own |
|-------|------------------------|----------------|
| **Base** | Language Standing; untrusted persona display-label; **conceptual** home for platform-citizen honesty (ledger = product truth; prior = re-verify; honest counts; handoff / next_steps short contracts; no silent host invent) and **RoE shell pattern** | Pack recon methodology; Graph stage/package law; skill encyclopedias |
| **Profession · Default** | Assistant intent→action (ledger Q&A, report on request, handoff for execution); **non-act** boundary | Recon; finding(confirm) booking doctrine; Expert Graph |
| **Profession · Expert** | Identity; short start order; attack-surface → skill **routing** principles; unified proof bar; deadend/rotation; fact/surface vs finding; booking honesty **pointers** | Full Graph settlement / packages / plan_node_id long law; skill bodies; Free/Graph dual dump; **do not re-author** citizen / next_steps longform already injected by platform-citizen |
| **Runtime · Free** | Pure OMP pointer; prefer Free continuity; permissioned enter-graph; product Graph L1 catalog (no stage dump); **run-varying RoE instance** (`formatRoeInjection`) | Stage success criteria; host settlement ceremony |
| **Runtime · Graph stage** | graph id + stage id/success; stage tool messaging; host-owned settlement; packages / plan_node_id when subagent on surface; stage-local todo discipline; hypothesis only if stage flag on; **fail-closed destructive / no-invent law** (not full Free RoE block) | Free whole-engagement multi-phase todo maps; Soft scenario menus; full profession encyclopedia (use core/compact in Profession) |
| **Runtime · capability** | Tools list; booking mode note; skill ids and/or skill L1 catalog; gated one-liners (subagent/fact/surface/progressive load); recipes pointer | Task target JSON; Standing policy |
| **Task** | target / scope / accounts / instruction; Case context; process-fact index; goals; handoff / prior seed projections; session title (auto-title when still「新会话」+ structured target) | Always-on methodology; do not duplicate this block onto the user turn |

#### 3.3.1 Implementation home today (Spec-honest partial — [#395](https://github.com/zangjiaao/my-ai-pen/issues/395))

The **conceptual** ownership above still guides pack authors and future moves. **Code today** (do not invent a silent third path):

| Concern | Conceptual layer | **Where the string lives in Node4 now** |
|---------|------------------|----------------------------------------|
| **Language Standing** | Base | `buildBaseLayer` — **first** content when injected (#352) |
| **Persona / seat meta** | Base | `buildBaseLayer` (pack id/label + untrusted persona display label) |
| **Platform citizen** (ledger honesty, re-verify, handoff, next_steps, no invent hosts) | Base (duty) | **Not** a separate Base block yet. At pack load (`mergePlatformCitizenMission` / `roles/platform-citizen.ts`), citizen lines are **prepended into `pack.missionLines`** and therefore render inside **Profession** via `buildProfessionLayer` for Default / Expert Free (and any path that uses full pack mission). Graph stage uses **compact** Profession, which **filters** citizen longform for size — stages do **not** re-get citizen as a Base string. |
| **RoE instance** (`formatRoeInjection`: template, allow_postex, allow_destructive, focus/bans) | Base shell pattern + run-varying flags | **Free Runtime** primarily (`buildPromptLayers` → `formatRoeInjection` as `### Rules of engagement`). Stage Runtime carries a **fail-closed** destructive / no-invent one-liner only — not the full RoE block. |
| **Tools / skill ids / gated one-liners** | Runtime · capability | Free / stage / worker Runtime builders |

**Pack authors:** do **not** duplicate platform-citizen or next_steps longform in `work.md` / pack how-to (already slimmed in T3). Rely on load-time citizen inject + Base Standing-first. Future **Option A** (move citizen into `buildBaseLayer` by splitting mission at `PLATFORM_CITIZEN_MARKER`, strip from Profession to avoid double-inject) remains valid but is **not** required for Spec/code agreement under this partial.

**Order invariant:** assembled prompt remains **Base → Profession → Runtime → Task**; Standing stays first inside Base regardless of where citizen/RoE strings currently render.

### 3.4 Seat vs work mode

- **Default** and **Expert** are **sibling seats**. Shared content is **Base only** — not Default Profession ⊂ Expert Profession.  
- **Free** and **Graph** are **work modes** on an Expert Participant Session; they select **Runtime** variants.  
- Default **never** enters Expert Graph (ADR 0001).  
- Free is default Expert work mode; Graph only with declared capability + user permission.  
- Layer selection is **structured only** — no free-text NLP invent of engagement/mode.

### 3.5 Path recipes (normative)

```text
Default:        Base + Profession(Default)  + Runtime(ledger tools, RoE as applicable) + Task
Expert Free:    Base + Profession(Expert)   + Runtime(Free + capability)              + Task
Expert Graph:   Base + Profession(Expert core|compact) + Runtime(Graph stage + capability) + Task
Package:        Base(trimmed) + Profession(compact) + Runtime(worker tools + optional one skill body) + Task(child) + return contract
```

| Path | Notes |
|------|--------|
| **Default Main** | Runtime has no Free/Graph mode block; ledger-oriented tools; RoE instance via `formatRoeInjection` in Runtime (§3.3.1). |
| **Expert Free Main** | Runtime Free is **thin**; Graph L1 catalog allowed; no Graph settlement long text; full RoE inject in Runtime. |
| **Expert Graph stage** | Profession core/compact **required** after P3; Runtime is stage contract + stage tools/skills + fail-closed destructive line (not full Free RoE block). |
| **Package worker** | Same seam; thinner Profession; optional single skill body in Runtime; return contract. |

**After P3:** Graph stage captains must not be methodology-poorer than Package workers on profession-core contract markers.

### 3.6 Progressive disclosure

- **Profession:** routing principles + “load at most one methodology skill body.”  
- **Skill bodies:** not always-on system layers.  
- **Graph stage JSON:** harness data, not Free system dump. Free Runtime may include Graph **L1** catalog only (id/label/when_to_use).

### 3.7 Size / necessity budgets (always-on)

Always-on text should keep **only rules that cause wrong behavior if omitted**. Prefer cut over clever duplication.

| Block | Target (guidance) |
|-------|-------------------|
| Base (Standing + persona; + citizen/RoE shell if/when Option A lands) | Prefer **≤ ~2k chars** of policy prose (excluding huge Case dumps). Today citizen chars count under Profession via pack mission prepend (§3.3.1). |
| Profession · Expert core | Prefer **≤ ~2–3k chars** / roughly ≤80 lines |
| Runtime · Free mode block | Prefer **≤ ~0.5k chars** (+ Graph L1 catalog lines as data) |
| Runtime · Graph stage law | Stage template; do **not** also ship full Graph law inside Free Profession |
| Task | Facts only; keep existing Case truncation discipline |

**Primary fat to remove in P2:** Free always-on Graph process chapters; duplicated next_steps/handoff already in Base; attack-class procedure prose → skills.

---

## 4. Assembler seam

### 4.1 Single seam

All product Agent Runtime system prompts assemble through **one** conceptual seam:

> **assemble system prompt({ base, profession, runtime, task }) → string**

Entry points (Default Main, Expert Free Main, Expert Graph stage captain, Package subagent) supply structured inputs; they must not maintain independent full-string dialects after **P1**.

### 4.2 Conceptual inputs

- **Base:** language Standing, persona policy; (Option A future: citizen lines + RoE shell)  
- **Profession:** resolved seat / pack mission+core work (Default or Expert); **today includes** pack-load–prepended citizen lines on full-mission paths  
- **Runtime:** work mode `free` | `graph_stage` | omit; stage context; tool names; skill ids/L1; gated notes; Free: `formatRoeInjection`; stage: fail-closed destructive/no-invent  
- **Task:** target/scope/instruction/accounts; Case context; process-fact index; goals; handoff snapshot  

User-turn prompts (stage user footers, continue prompts) may stay separate but must not reintroduce a second **system** dialect for profession law.

### 4.3 Product state remains SOT

Prompt text **steers**. Finding Store, surface ledger, Feedback, Session work mode, and settlement remain host Product state — not “true because the prompt said so.”

---

## 5. Content migration rules

### 5.1 One rule, one home

When de-duplicating: keep the copy in the home layer (§3.3); replace others with a one-line pointer or delete.

### 5.2 Pentest how-to split (P2)

| Current mixed concern | Destination |
|----------------------|-------------|
| Free vs Graph pointer, enter_graph | Runtime · Free |
| Packages, plan_node_id, host settlement, stage-local todos | Runtime · Graph stage |
| Hypothesis stage flag behavior | Runtime · Graph stage (when enabled) |
| Proof bar, surface→skill routing, deadend, fact vs finding | Profession · Expert |
| Attack-class procedures | Skills (progressive) |
| Ledger / handoff / next_steps / honest counts | Base (delete pack duplicates) |
| Tools list, skill ids/L1, tool one-liners | Runtime · capability |

### 5.3 Non-goals of content edit

- No target-specific profiles, expected vuln counts, or answer keys.  
- No Soft scenario inject.  
- No new hardcoded user-visible workflow simulation tables.  
- No return to six-layer product taxonomy.

---

## 6. Profession-core contract (P3)

Graph stage (and compact Profession) must still convey **at least**:

1. Progressive skill load discipline (at most one methodology body; skills ≠ ACLs).  
2. Unified proof expectations before product booking (causality / reproducibility / impact — or equivalent stable phrasing).  
3. Process cognition vs product findings separation (fact/surface vs finding confirm).  
4. No invent surfaces/proof; stay in Scope/RoE.

Exact stable **markers** for tests are chosen in the PR that lands P3 (prefer existing English rule phrases already in packs over new magic tokens). Document markers in that PR.

---

## 7. Phased delivery

| Phase | Deliverable | Behavior change? | Gate | Status |
|-------|-------------|------------------|------|--------|
| **P0** | Inventory: map current blocks → **Base / Profession / Runtime / Task**; mark duplicates and fat | No | Checklist on #386 or PR | Done (pre-impl) |
| **P1** | Unified four-layer assembler; wire Default + Expert Free Main | Prefer **parity** (external contracts unchanged) | Existing prompt contracts green + assembler unit tests | **Shipped** via [#387](https://github.com/zangjiaao/my-ai-pen/issues/387) T1 |
| **P2** | Slim Profession core; thin Free Runtime; move Graph-only out of Free always-on; hit §3.7 budgets where practical | Content shape; Free methodology preserved | Free contract suite + size checklist | **Shipped** via [#388](https://github.com/zangjiaao/my-ai-pen/issues/388) T2 + [#389](https://github.com/zangjiaao/my-ai-pen/issues/389) T3 |
| **P3** | Graph stage uses same seam + Profession core/compact; Package workers same seam | Graph gains profession core; third dialect ends | Stage profession-core tests mandatory; Package seam tests | **Shipped** via [#390](https://github.com/zangjiaao/my-ai-pen/issues/390) T4 + [#391](https://github.com/zangjiaao/my-ai-pen/issues/391) T5 |
| **P4** | Living docs, README index, pack authoring notes; PRD only if product-visible posture changes | Docs | Index + authoring § | **Shipped** via [#392](https://github.com/zangjiaao/my-ai-pen/issues/392) T6 |

Prefer incremental PRs per phase. Do not block P1 on perfect content rewrite. **After P4:** keep this Spec living when layer ownership or path recipes change; do not reintroduce L0–L5 product vocabulary.

---

## 8. Testing (normative)

### 8.1 Primary seam

Test **`assemble system prompt → string`** as the highest seam. Assert presence, absence, and **order** of the four layers. Avoid full golden encyclopedias.

### 8.2 Required suites

1. **Order:** Base (Standing first) → Profession → Runtime → Task — all paths.  
2. **Default:** non-act; no Expert recon/booking doctrine; no Graph stage law.  
3. **Expert Free:** profession core + thin Free Runtime + skills progressive + RoE; Graph L1 catalog without stage dump when pack declares product graphs.  
4. **Expert Graph stage:** profession core/compact markers + stage Runtime + tool/skill gating + handoff Task facts.  
5. **RoE:** post-ex skill ids withheld when post-ex false.  
6. **Capability gating:** tool one-liners only if tools present.  
7. **Package worker:** same seam; return contract; optional single skill body.  
8. **Negatives:** no Soft mode; no instruction NLP routing module; no L0–L5 public API names required.  
9. **Slimness (P2+):** Free always-on must not re-include full Graph process-quality chapters (contract: absence of stage-settlement longform markers that belong only in Graph Runtime).

### 8.3 Prior art

Standing-first language tests; Graph L1 catalog injection tests; skill L1 no-body tests; RoE injection tests; Hard Graph stage prompt contracts; Node smoke persona/pack checks. Extend these styles.

---

## 9. Out of scope

- Soft scenario Graph revival  
- Dual product kernel / non-Node4 bind path  
- Platform/Node free-text intent routing  
- Hard Graph topology / Feedback algorithm redesign  
- Finding Store or surface ledger schema redesign  
- Bulk new skill/ref encyclopedias  
- UI dual-rail redesign; multi-Expert true-parallel  
- Translating raw tool stdout  
- Default becoming an execution seat or gaining Expert Graph  
- Six-layer (L0–L5) as ongoing product taxonomy  

---

## 10. Authoring rule of thumb

| If the rule is… | Put it in… |
|-----------------|------------|
| True for every product citizen Agent / node policy / RoE shell | **Base** (conceptual; do **not** re-author citizen/next_steps in pack `work.md` — host injects citizen at pack load today, §3.3.1) |
| How *this seat* works (assistant vs expert judgment) | **Profession** (`mission.md` + short `work.md` only) |
| Free vs Graph harness, tools, skill catalogs this run; run-varying RoE flags | **Runtime** (host-owned; Free gets full RoE inject) |
| This turn’s target / instruction / handoff facts | **Task** |
| Attack-class procedure depth | **Skill body** (not always-on Profession) |

**Keep Profession short. Keep Free Runtime thin. Put Graph law only in Graph Runtime. Load skills on demand.**

Pack authors: the experts catalog README points here — see [`experts/README.md`](../../experts/README.md) (**Pack authoring (system prompt layers)**). Pack files map as: `mission.md` + `work.md` → Profession; `skills/` → progressive skill bodies (not always-on Profession). Platform citizen is **not** authored in pack files — `load-pack` prepends it into mission lines (appears in Profession string until Option A).

### 10.1 Expert pack author checklist

Short checklist for pack authors (Spec [#386](https://github.com/zangjiaao/my-ai-pen/issues/386); polish [#405](https://github.com/zangjiaao/my-ai-pen/issues/405)):

| File | Duty |
|------|------|
| **`mission.md`** | **Identity** — who this seat is / job boundary. Keep short. |
| **`work.md`** | **Hard rules only** — start order, proof bar, deadend/rotate, fact/surface vs finding pointers. Prefer ≤ ~2–3k chars. |
| **`skills/*/SKILL.md`** | **Class depth** — procedure for one attack class or recon entry. Progressive load; not always-on Profession. |

**Do:**

1. **Opening skills mutually exclusive** — each entry skill’s *When to load* / *When not to load* must not both claim the same default start (e.g. app recon vs host/port enum). Align with work.md “at most one” start order.
2. **Skill when / not load** — every methodology skill states both; agents route from observed surface, not a coverage checklist.
3. **Free/Graph pointer in work** — one short line only: mode / Graph catalog live in **Runtime** (host). No Free multi-phase todo maps or Graph dual dump in always-on Profession.

**Do not put in `work.md`:**

- Platform-citizen / next_steps / handoff longform (host injects at pack load — §3.3.1).
- Graph settlement law (host-owned stage settlement, packages[], `plan_node_id` ceremony, stage success encyclopedias).
- Attack-class procedure bodies (those are skills).

---

## 11. References

- Issue [#386](https://github.com/zangjiaao/my-ai-pen/issues/386) and implementation tickets [#387](https://github.com/zangjiaao/my-ai-pen/issues/387)–[#392](https://github.com/zangjiaao/my-ai-pen/issues/392); follow-ups [#393](https://github.com/zangjiaao/my-ai-pen/issues/393)–[#395](https://github.com/zangjiaao/my-ai-pen/issues/395) (seam purity / compact Profession / Spec-honest citizen+RoE homes); author checklist polish [#405](https://github.com/zangjiaao/my-ai-pen/issues/405)  
- ADR 0001 Graph × Pi  
- Specs: participant-session (#277), graph-catalog-work-mode-ui (#278), composer-graph-harness-bind (#284), hypothesis-evidence (#274), harness, task-graph  
- `CONTEXT.md` product seats / work mode / Expert Graph  
- `AGENTS.md` intent and harness rules  
- Pack authoring entry: [`experts/README.md`](../../experts/README.md)  
- pi-coding-agent reference (frozen): `research/pi/packages/coding-agent/src/core/system-prompt.ts`

| Date | Change |
|------|--------|
| 2026-08-16 | Harness channel (#481): outer continue / persist-pass / checkpoint are `role=harness`, not fake user turns. Mid-run nudges stay on the tool result. |
| 2026-08-16 | Case group speech: `case_context.speech` log + Session cursor; harness `### Case speech` is unread others only. System `### Thread` retired. |
