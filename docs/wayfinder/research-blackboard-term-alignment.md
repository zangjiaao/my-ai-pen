# Research: Blackboard term vs Black-cat vs our shared state

Facts + careful vocabulary mapping only. **No product implementation.**  
Ticket: GitHub [#264](https://github.com/zangjiaao/my-ai-pen/issues/264). Part of map [#261](https://github.com/zangjiaao/my-ai-pen/issues/261).

**Out of ticket:** final product learnings list (sibling synthesis; not this file).

---

## Question

How should we **align vocabulary** for the X-context comment *「目前自动化渗透测试，黑板架构是相对比较优的解法」* with:

1. classic multi-agent **blackboard** architecture,
2. what **Black-cat** actually ships (`research/Black-cat`),
3. our **Product state / ledgers** (Finding Store, surface ledger, handoff).

The tweet/comment is **context**, not architecture proof.

---

## Executive answer

| Claim | Verdict |
| --- | --- |
| Classic **blackboard** | Three-part architecture: **Knowledge Sources (KS)** + **shared blackboard** + **control** (which KS runs next). Primary AI literature (Nii 1986; Corkill multi-agent blackboard). |
| **Black-cat implements classic blackboard?** | **No.** It ships a **hypothesis-first state machine** with a single markdown **Engagement Tracker** as runtime SOT. One agent loop; no multi-KS board or separate control component. |
| **Our platform is a classic blackboard?** | **No as a product name.** We have **blackboard-like shared Product state** (Finding Store, surface ledger, stage/parent continuity, Case handoff) under **host-owned settlement** and **Hard Graph control** — not opportunistic multi-KS scheduling. |
| Using **「黑板」** in product docs | **High term risk** if equated with Black-cat, with classic blackboard, or as a synonym for Graph × Pi. Prefer **Product state / ledgers / Finding Store / surface ledger / handoff**; use “blackboard-like shared state” only with an explicit classic-definition caveat. |

---

## 1. Classic blackboard (primary-sourced definition)

### Canonical components

In classical AI, a **blackboard system** is a problem-solving organization with three cooperating parts:

1. **Knowledge Sources (KS)** — independent specialist modules. Each KS can examine the shared board, decide whether it can contribute, and write incremental results. KS are typically loosely coupled and do not call each other directly.
2. **Blackboard** — a shared global data structure (often leveled: hypotheses, partial solutions, evidence) that is the sole medium of intermediate results.
3. **Control component** — decides *which* KS to activate *when*, based on the current board state (and often agendas / focus). Control is separate from any single KS’s domain expertise.

This three-part framing is standard in the blackboard literature, notably:

- **H. Penny Nii**, *“Blackboard Systems: The Blackboard Model of Problem Solving and the Evolution of Blackboard Architectures,”* *AI Magazine* 7(2), 1986 (AAAI AI Magazine; DOI-era citation: Nii 1986). Nii presents the blackboard model as an evolutionary architecture for incremental, opportunistic problem solving with multiple knowledge sources cooperating over a shared structure.
- **Daniel D. Corkill**, multi-agent / distributed blackboard work (e.g. *Blackboard Systems*, AI Expert / BB1-lineage surveys; Corkill on multi-agent blackboard control). Emphasizes that the architecture scales to **multiple agents** reading/writing a shared board under explicit or implicit control policies — not merely “one process keeps a notes file.”

**Minimal operational definition used in this note:**

> A system implements a **classic blackboard** only if (a) multiple semi-independent **KS/agents** contribute partial results, (b) a **shared structured board** is the coordination medium, and (c) a **control policy** (scheduler, agenda, or equivalent) chooses contributions from board state — not a single sequential pipeline that merely appends to a log.

### What classic blackboard is *not*

| Not classic blackboard | Why |
| --- | --- |
| Unidirectional pipeline (recon → scan → exploit → report) with phase-local files | No opportunistic multi-KS control over a shared board |
| One LLM + one markdown tracker updated by that same LLM | Shared *document*, but not multi-KS + control |
| Fixed stage graph with host gates | May share state, but **control is the graph/host**, not board-driven KS selection |
| Chat transcript as coordination medium | Ephemeral narrative; classical board is structured intermediate state |

---

## 2. Does Black-cat implement classic blackboard?

**Primary sources (local tree):**

- `research/Black-cat/README.md`
- `research/Black-cat/skills/pentest-redteam/SKILL.md`
- `research/Black-cat/skills/pentest-redteam/templates/engagement-tracker.md`

### What Black-cat claims to be

Black-cat’s README positions the design explicitly as **not** a tool-first pipeline, but as:

- **Hypothesis-first** execution (signal → hypothesis → validate),
- a **state machine with back-edges**: `RECON ⇄ ENUMERATE ⇄ VALIDATE` (and later EXPLOIT / POST-EXPLOIT / REPORT),
- runtime truth in a **single Engagement Tracker** document (`Active` / `Confirmed` / `Killed` / Deferred / Attack Surface / Cleanup / Decisions),
- **explicit technique file routing** (default 1 technique file, max 2),
- evidence chain under `evidence/{id}/`.

README contrast table (paraphrased from source language): market skills = pipeline; this skill = **state machine** + hypothesis + tracker SOT. It does **not** label itself “blackboard” in the local sources.

### Mapping to classic three parts

| Classic part | Black-cat | Match? |
| --- | --- | --- |
| **Knowledge Sources** | One Claude Code agent loop; technique files are **prompt/context packs**, not independent KS that self-trigger | **No** multi-KS |
| **Blackboard** | `./engagement-tracker.md` — single markdown SOT, incremental append in engagement mode; Focused mode may skip tracker | **Partial** shared *document*, not multi-writer structured board levels |
| **Control** | L2 attack **state machine** + Decision Gates recorded in tracker; routing table chooses which technique file to read | **Agent-internal** control, not a separate control component over many KS |

### Argument

1. **Single writer, single cognitive loop.** Engagement Tracker is “运行时唯一真相源” maintained by the same skill-guided agent. Classic blackboard expects **multiple** knowledge sources whose contributions are scheduled against a board.
2. **Technique files ≠ KS.** `web.md` / `ad.md` / … are **explicit file-routing context**, loaded one (max two) at a time. They do not independently watch the board and bid for activation.
3. **Control is a state machine, not board-agenda scheduling.** Transitions (RECON ↔ ENUMERATE ↔ VALIDATE, back-edges on disproof/new signal) live in SKILL.md L2. That is **workflow control embedded in the skill**, not a Corkill-style control shell over competing KS.
4. **Focused validation mode** explicitly **does not initialize the tracker** — a pure single-hypothesis path with no shared board at all.

**Conclusion:** Black-cat is best described as a **hypothesis-driven engagement state machine + single-document engagement ledger** for one coding-agent skill. Calling it a **classic blackboard** is a **false equivalence**. At most: “blackboard-*adjacent* shared working memory” (one agent’s structured notes), which is **weaker** than the classical definition in §1.

The X comment *「黑板架构是相对比较优的解法」* may use 「黑板」 loosely (shared engagement memory / non-pipeline coordination). That colloquial use must **not** be imported as a claim that Black-cat = Nii/Corkill blackboard, nor that our product should adopt that name without definition.

---

## 3. Does our platform implement blackboard-like shared state?

**Primary sources (product authority):**

- `CONTEXT.md` — Product state, Handoff, Runtime transcript, Feedback, Graph × Pi
- `docs/specs/task-graph.md` — Hard Graph continuity, Finding Store, surface ledger, host settlement (Spec #125)
- `docs/specs/harness.md` — Finding Store booking path, subagent handoff, Case-shared materials
- ADR 0001 — Product state as SOT; Runtime transcript subordinate

### What we actually have (shared state inventory)

| Artifact | Role | Owner / writers | Classic-board analog |
| --- | --- | --- | --- |
| **Product state (SOT)** | Domain truth: session jars, Hard Graph continuity, findings/booking, Feedback inputs | Node4 host + structured agent tools; **not** Runtime transcript | Umbrella “board” *of record* |
| **Finding Store** | Run-scoped vuln intelligence; package ingest → L0 → Main `finding(confirm)` → platform ledger | Packages / Main via tools; host settlement enforces honesty | **Findings / hypothesis** level of a board |
| **Surface ledger** (`taskDir/surfaces/ledger.json`) | Attack-surface coverage truth (`open` → `in_probe` → `probed` \| `booked` \| …) | Recon packages / `fact(op=surface)` / booking side-effects | **Surface inventory** level |
| **Stage / parent continuity** | Host-projected candidates, package terminals, structured stage results | **Host settlement only** for gates; agent `result.json` ignored for business gates | Continuity snapshot, **not** agent-owned board file |
| **Session jars** | Multi-actor cookies/auth across stages/packages | Seed/promote host helpers | Shared **environment** state (not classical KS hypotheses) |
| **Case-level Handoff** | Cross-run **Truth** + **Next** (Workset) + Delivery envelope | Platform / structured fields; Agent does not self-adopt Next as SOT | Long-horizon shared case state (beyond one Graph run) |
| **Runtime transcript** | Turn-local agent messages | Agent Runtime | Explicitly **not** Product SOT / not fail-closed gate input |

### Match vs diverge (classic three parts)

| Classic part | Our product | Match? |
| --- | --- | --- |
| **Knowledge Sources** | Stage Main + **subagent packages** (Agent Graph workers) + optional multi-expert Case seats | **Partial** — multiple actors write *into* shared stores, but they are **dispatched** by Graph/Main, not self-bidding KS |
| **Shared board** | Finding Store + surface ledger + host continuity + Case materials | **Strong partial** — structured multi-level shared state is real |
| **Control** | **Hard Graph runner** owns stage order; **Feedback L0/L1** on Product state; Main is **not** stage scheduler on Expert seat; host settlement law (Spec #125) | **Diverges** — control is **graph + host gates**, not opportunistic blackboard control that activates whichever KS best matches board events |

### Blackboard-*like* properties we *do* have

- **Shared structured intermediate state** survives stage boundaries (Store, ledger, jars) while per-stage workdirs stay isolated for audit artifacts.
- **Multiple writers** (package workers) contribute candidates/surfaces; Main books; host projects honesty.
- **Gates read Product state**, not chat prose — closer to “control inspects the board” than “control parses the transcript.”

### Properties that keep us *out* of classic blackboard naming

- **Host settlement is law:** agent-authored `result.json` is **not** the handoff/booking channel. Classic blackboard usually treats the board as the *open* write surface for KS; we **split** agent exploration from **host-owned** gate inputs.
- **Control is predeclared stage order** (pack graphs) + Feedback, not a general agenda of independent KS.
- **Default seat never enters Expert Graph**; Expert work is Graph-only — product seats are not “any KS may fire on any board event.”
- **Intent/workflow** must come from Agent judgment or explicit structured fields — not keyword tables (AGENTS.md). That is orthogonal to blackboard, but forbids hiding a “blackboard mode” behind free-text heuristics.
- **Platform ledger / Case** is long-term SoT; Finding Store is **run** SoT for Graph booking — dual horizon, not one eternal board.

**Conclusion:** Our platform implements **structured shared Product state with multi-actor contribution and host-controlled settlement** under **Graph × Pi**. That is **blackboard-like at the data layer**, **not** a claim that we implemented (or should rebrand as) a classic multi-KS blackboard architecture. Prefer product terms already in `CONTEXT.md`.

### Side-by-side (Black-cat vs us vs classic)

| Dimension | Classic blackboard | Black-cat | my-ai-pen (Node4) |
| --- | --- | --- | --- |
| Coordination medium | Structured multi-level board | One markdown Engagement Tracker (engagement mode) | Finding Store + surface ledger + host continuity + Case handoff |
| Who writes | Multiple KS | Single agent skill loop | Main + packages (+ host projection) |
| Who schedules next work | Control component / agenda | Embedded state machine + Decision Gates | Hard Graph runner + Feedback; Main packages within stage |
| Failure / disproof | Board updates; other KS may react | Hypothesis → Killed; back-edge in SM | Package honesty / Store status / boss re-dispatch; stage L0/L1 |
| Evidence | Board entries | `evidence/{id}/` chain | Store proof + book-path L0; platform `vuln_found` |
| SOT for gates | Board + control policy | Human/agent reading tracker (no separate host gate product) | **Host settlement on Product state** only |

---

## 4. Term risk — when 「黑板」 confuses

### High-risk uses (avoid in living product docs)

| Phrase | Why it confuses |
| --- | --- |
| 「我们是黑板架构」 / “we are a blackboard system” | Readers import Nii/Corkill multi-KS + control; we are Graph × Pi + Product state |
| 「Black-cat 的黑板」 as if Black-cat = classic blackboard | Black-cat sources say **state machine + tracker**, not blackboard |
| 「黑板 = Engagement Tracker」 as product design target | Tracker is a **skill-local markdown SOT**; our SOT is **host Product state** with fail-closed settlement |
| 「黑板」 as synonym for Finding Store alone | Store is one **level** of shared state; omits surface ledger, jars, Case handoff, Feedback inputs |
| Colloquial X comment as architecture decision | Comment is **opinion context**, not a primary architecture source for either tree |

### Lower-risk / acceptable phrasing

| Prefer | When |
| --- | --- |
| **Product state (SOT)** | Umbrella domain truth (CONTEXT.md) |
| **Finding Store** / **surface ledger** / **handoff** | Specific artifacts |
| **Shared engagement state** / **structured shared state** | Informal contrast with pure chat-transcript coordination |
| **Blackboard-like shared state** | Only with a one-line caveat: multi-writer structured intermediate state **without** claiming classic multi-KS control |
| **Hypothesis / evidence working memory** | When discussing Black-cat tracker or Active/Confirmed/Killed semantics without equating products |

### Mapping table for the X comment

| If someone hears… | Align to… | Do not align to… |
| --- | --- | --- |
| 「黑板」 as *shared memory better than pure pipeline* | Shared Product state / tracker-style engagement memory vs one-way phase scripts | Instant claim we should rename Graph to blackboard |
| 「黑板」 as *multi-agent write shared board* | Partial: packages → Store/ledger under host | Full classic KS architecture already shipped |
| 「黑板」 as *Black-cat’s secret sauce* | Hypothesis-first SM + Engagement Tracker + evidence chain | Our Graph runner / Feedback law |

### Doc guidance (vocabulary lock for later maps)

1. **Do not** adopt 「黑板架构」 as a product seat, workflow, or ADR-level architecture name without a new domain decision that defines KS + board + control against Graph × Pi (out of this ticket; ADR 0001 remains locked).
2. **Do not** describe Black-cat as a blackboard system in contrast docs; describe **state machine + Engagement Tracker SOT + hypothesis/evidence**.
3. **Do** describe our multi-stage continuity as **Product state / host settlement / ledgers** when contrasting with pipeline-only or transcript-only systems.
4. If external discourse uses 「黑板」, translate on first use: *“colloquial ‘blackboard’ ≈ shared structured engagement state; classic AI blackboard = KS + board + control — neither Black-cat nor our product claims the classic triple as product name.”*

---

## Sources

### Classic AI

- H. Penny Nii, *Blackboard Systems: The Blackboard Model of Problem Solving and the Evolution of Blackboard Architectures*, *AI Magazine* 7(2), 1986 — canonical three-part blackboard model (KS, blackboard, control) in the AI Magazine / AAAI lineage.
- Daniel D. Corkill — multi-agent / distributed blackboard control surveys (BB1 lineage and multi-agent blackboard control papers) — multi-agent reading/writing a shared board under control policies.

### Black-cat (local frozen research tree)

- `research/Black-cat/README.md` — state machine vs pipeline; Engagement Tracker as runtime SOT; hypothesis-first.
- `research/Black-cat/skills/pentest-redteam/SKILL.md` — L2 attack state machine; engagement vs focused modes; technique routing.
- `research/Black-cat/skills/pentest-redteam/templates/engagement-tracker.md` — tracker sections (Active/Confirmed/Killed/…).

### Product (living)

- `CONTEXT.md` — Product state, Handoff, Runtime transcript, Graph × Pi, Feedback.
- `docs/specs/task-graph.md` — host settlement, Finding Store, surface ledger, stage continuity.
- `docs/specs/harness.md` — booking path, subagent handoff, Case-shared evidence.
- `docs/adr/0001-graph-x-pi-product-path.md` — Product state SOT; transcript subordinate.

### Context only (not architecture proof)

- X thread / comment triggering map #261 (*「目前自动化渗透测试，黑板架构是相对比较优的解法」*).

---

## Non-goals (this ticket)

- Final “worth learning / already have / do not learn” product list → sibling synthesis ticket on map #261.
- Product code, renames, or ADR changes.
- Implementing a classic multi-KS blackboard runtime.
- Resolving sibling contrast / learnings tickets.
