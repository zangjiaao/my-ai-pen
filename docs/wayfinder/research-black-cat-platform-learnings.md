# Research: Black-cat vs platform — contrast matrix and product learnings

> Ticket: GitHub **#265** · Map **#261** ([Wayfinder: Black-cat vs platform — contrast and learnings](https://github.com/zangjiaao/my-ai-pen/issues/261))  
> Date: 2026-07-31  
> **This file is the map destination artifact** (对照 + 借鉴价值判断). No product code.

## Inputs (closed research)

| Ticket | Findings |
|--------|----------|
| [Research: Black-cat architecture fact model](https://github.com/zangjiaao/my-ai-pen/issues/262) | [`research-black-cat-architecture.md`](./research-black-cat-architecture.md) |
| [Research: Our platform SOT Graph hypothesis evidence model](https://github.com/zangjiaao/my-ai-pen/issues/263) | [`research-platform-sot-graph-hypothesis.md`](./research-platform-sot-graph-hypothesis.md) |
| [Research: Blackboard term vs Black-cat vs our shared state](https://github.com/zangjiaao/my-ai-pen/issues/264) | [`research-blackboard-term-alignment.md`](./research-blackboard-term-alignment.md) |

**Charting locks (map #261):** ADR 0001 Graph × Pi stays locked; author tweet ≠ our benchmark; judgments are **value advice**, not merge commitments.

**Two-leg model (owner refinement after #265):** dig quality needs **process** *and* **domain knowledge**. Rejecting “整包 technique 百科当 gate SOT / answer key” is **not** “Agent 可以零知识只靠假设”. Black-cat effect claims are best read as **hypothesis loop + thick techniques + thin load**, not tracker alone.

---

## Executive answer

| Question | Answer |
|----------|--------|
| What is Black-cat? | A **Claude Code skill**: hypothesis-first **state machine** + optional **Engagement Tracker** markdown SOT + **thick** `techniques/*.md` content loaded with **≤2 explicit signal routing** + evidence chain. Not a multi-tenant platform; not a host Graph runner. |
| What are we? | **Node4 Graph × Pi + platform**: host-owned **Product state** (Finding Store, surface ledger, settlement, Case handoff), Hard Graph stages/packages/Feedback, hypothesis **steered** by mission/`work.md`/stage intent — not a named Hypothesis Store. Expert pack already has **skills + refs** (attack-class oriented); depth/breadth and **routing discipline** vs Black-cat’s six technique books are an open product risk, not a measured lab result. |
| Two legs | **Process leg** = how work is remembered and cycled (queue, disprove, gates, SOT). **Knowledge leg** = what hypotheses the agent can *form* (model priors + loadable skills/techniques + signal recognition). **Already-have** on the process/SOT side does **not** guarantee **breadth of attack surface tested**. |
| Is either a classic **blackboard**? | **No.** Classic = KS + shared board + control (Nii 1986). Black-cat = single-agent SM + tracker. We = blackboard-**like** multi-writer Product state under **Graph + host control**. Prefer product vocabulary; avoid 「黑板架构」 as product name. |
| Do we already “have shared state”? | **Yes — stronger than Black-cat’s tracker** for multi-actor, multi-stage, fail-closed booking (“测到的能诚实落地”). That is **not** the same as “会想到去测什么”. |
| Where dig quality still learns | **Process:** hypothesis lifecycle (Active/Killed/Deferred + prove/disprove/revisit), Decision Log, verification ritual, stall→defer, cleanup. **Knowledge:** progressive **signal-triggered** technique/skill library (厚内容、薄上下文), attack-class families not answer keys; pair with P0 queue so “还能立哪些类” has somewhere to land. Not kernel replacement. |

---

## 1. Contrast matrix

| Dimension | Black-cat | Our platform (Node4 × platform) | Notes |
|-----------|-----------|----------------------------------|-------|
| **Host form** | Claude Code skill (markdown + templates) | Platform + Node4 process; Expert pack + Hard Graph runner + pi Runtime | Different product class |
| **Control flow** | Documented SM: `IDLE→RECON⇄ENUMERATE⇄VALIDATE→EXPLOIT→POST-EXPLOIT→REPORT` with back-edges | Hard Graph ordered stages (`init→surface→…→class_probe→…→validate_book`); boss loop re-dispatch; no free mid-run Graph hot-switch as V1 default | Both non-linear; ours **host-enforced**, theirs **skill-instructed** |
| **Who schedules** | Same LLM loop + skill gates | Hard Graph runner owns stage order; Main packages within stage; Feedback L0/L1 | Ours: Main ≠ stage scheduler on Expert |
| **Work-state SOT** | Engagement: `./engagement-tracker.md` (7 zones); Focused: **no** tracker | Product state: Finding Store, surface ledger, session jars, host stage settlement; platform ledger after confirm | Ours multi-artifact + host law; agent `result.json` not gate SOT |
| **Hypothesis lifecycle** | Active (prove/disprove fields) → Confirmed / Killed / Deferred | No Hypothesis Store; mission/`work.md`/stage intent/`this_turn_goal` steer “hypothesis-driven” | **Largest dig-quality gap** on *explicit* queue semantics |
| **Evidence chain** | observation → reproduction → impact under `evidence/{id}/` | proof + PoC into Store; book-path L0; Case evidence at confirm | Same spirit; ours fail-closed on shape/severity |
| **Verification bias control** | Mandatory VALIDATE declaration (“assume false positive…”) | feedback_ok / reject; invent-without-id ban; no fixed verbal ritual | Ritual is cheap pack-level candidate |
| **Disproof** | Killed + revisit conditions; not delete | deadend / package fail / Store reject; honest partial | We lack first-class “killed hypothesis with revisit” board |
| **Attack surface** | Tracker Attack Surface zone (append) | `surfaces/ledger.json` status machine | **We already stronger** |
| **Decisions** | Decision Log at gates (options / chose / why) | Boss loop actionable lists; L0 machine fields; little durable “options considered” log | Learnable as observability / captain memory |
| **Context routing** | Signal → 1 technique file; max 2; no preload | Skills + progressive load principle; Graph stage tool profiles; risk of encyclopedia prompts | Learn **routing discipline** |
| **Domain knowledge surface** | Six large `techniques/*.md` (web/ad/cloud/db/evasion/reversing) — long-tail methods, CVE chains, escalate paths | Pack `skills/*` + `refs/{payloads,components,chains}` — attack-class oriented; not a measured parity vs Black-cat thickness | **Knowledge leg:** content as **loadable** pack assets, not gate SOT; thin load ≠ thin library |
| **Multi-agent** | Single agent loop | Main + package subagents; idle pool; Case multi-expert `case_context` | We are multi-actor; Black-cat is not |
| **Failure / back-edge** | Disprove/fail/new signal → back to earlier SM state | Stage L0 fail → Main re-dispatch/abandon; blocked → booking-only tail + close-out | Different back-edge *shape*; both non-pipeline |
| **Cleanup** | Cleanup ledger before REPORT | RoE/destructive gates; no first-class engagement cleanup ledger like Black-cat | Relevant for deep/postex graphs |
| **Time / stall budget** | 80/50/20% gates; 3 OODA rounds → Deferred | Package ≤2 waves; stage/L1 budgets; discovery-yield soft metrics | Stall→defer is sharper for hypothesis thrash |
| **Booking / multi-tenant** | N/A (workspace files) | Platform ledger, authorize, multi-Case | Product requirement Black-cat never solves |
| **Default seat** | N/A (always “skill on”) | Default never Expert Graph; no finding booking | Seat split is our product, not theirs |
| **「黑板」** | Not self-named; colloquial comment ≠ design | Blackboard-like Product state only | See §0 vocabulary |

### 0. Vocabulary lock (from blackboard research)

| Prefer in product docs | Avoid |
|------------------------|--------|
| Product state / Finding Store / surface ledger / handoff | 「我们是黑板架构」 |
| Hypothesis-first SM + Engagement Tracker (when describing Black-cat) | 「Black-cat 的黑板」 as classic KS blackboard |
| “Blackboard-like shared state” + one-line classic caveat | Equating Graph × Pi with Nii/Corkill blackboard |

---

## 2. Learnings draft (product capability)

Judgments below assume **Graph × Pi remains product path**. “Where it would sit” is a placement hint for a future Spec map — **not** a Spec.

### 2.1 值得借鉴 (worth learning)

Split into **process** and **knowledge**. Only process → better honesty on a **narrow** hypothesis space. Only knowledge without queue → more ideas, more thrash / forgotten disproofs.

#### Process leg

| # | Mechanism | Why it may help dig quality | Priority | Where it would sit |
|---|-----------|----------------------------|----------|-------------------|
| L1 | **Explicit hypothesis queue** with Signal / Test / **Prove if** / **Disprove if** / status Active→Confirmed\|Killed\|Deferred | Structures “立了什么 / 证伪了什么”; closer to human OODA; feeds Main packages | **P0** | Product state or stage-visible sibling (not chat); pack `work.md` + package framing |
| L2 | **Disprove ≠ failure + revisit conditions** (Killed retained) | “sqlmap negative ⇒ ORM / other path” style rotation with memory | **P0** | Same as L1; deadend notes carry revisit text |
| L3 | **Decision Log** (options / chose / why) at branch points | Captain strategy + audit; boss loop is weak on *alternatives considered* | **P1** | Stage captain Product-state log / close-out appendix |
| L4 | **Stall policy** (N rounds no progress → Deferred; time-budget re-eval) | Cuts endless thrash on one path | **P1** | Pack harness + optional host soft signal; no expected-vuln counts |
| L5 | **Verification-mode ritual** before confirm-class work | Anti-confirmation bias at VALIDATE / validate_book | **P1** | Pack prompts; does **not** replace book-path L0 |
| L7 | **Cleanup ledger** for engagement artifacts | Postex / lateral / RoE honesty | **P2** | `redteam_deep` + close-out |
| L8 | **ENUMERATE bar** (≥2 Active with disprove conditions before deep tunnel) | Hypothesis diversity before exploit fixation | **P2** | Soft harness surface→class_probe; **not** fixed finding-count gate |

#### Knowledge leg (owner refinement — first-class, not “out of architecture”)

| # | Mechanism | Why it may help dig quality | Priority | Where it would sit |
|---|-----------|----------------------------|----------|-------------------|
| L6 | **Progressive load discipline** — library may be thick; **active context default 1, max 2** deep packs; no full encyclopedia in system prompt | Author’s “framework becomes burden” lesson; sparse *working set* | **P0** | Pack skill/refs routing + harness progressive load — **enforce**, not only document |
| L9 | **Signal-triggered domain content** — recon/surface signals load attack-class / technique families (JWT → jwt methods pack; GraphQL → gql pack), **not** “this target must have N JWT vulns” | Broadens **hypothesis space** beyond model Top-ish priors; matches Black-cat routing table spirit | **P0** | Expert pack `skills/` + `refs/` + optional technique books; Agent or structured stage chooses load — **no** platform free-text keyword invent of engagement (AGENTS.md) |
| L10 | **Thick technique depth where product needs breadth** — long-tail methods, escalate chains, AD/cloud only when authorized signal/task | Without content, process only optimizes common classes; Black-cat “效果好” is plausibly **loop + thickness** together | **P0–P1** | Curated pack content (human-maintained); depth by seat/graph (app vs redteam_deep); **never** gate SOT or answer key |
| L11 | **Restricted auto-load for heavy domains** (Black-cat: ad/evasion only explicit) | Avoids context explosion and unauthorized depth | **P1** | Same as L9 with hard “explicit task/signal only” for AD/postex/evasion |

**Implication for “面不够广”:** as a **product risk judgment** (not a lab scorecard): if Expert loadable knowledge is thinner or poorly routed vs Black-cat’s six technique books, coverage will skew toward model-common classes even with strong Graph/SOT. Fix = **L6+L9+L10 alongside L1+L2**, not either alone.

### 2.2 已具备不必学 (already covered — do not copy as-if-new)

| Mechanism | We already have | Product terms / path |
|-----------|-----------------|----------------------|
| Shared structured engagement memory vs pure chat pipeline | Product state, Store, surface ledger, host settlement | `CONTEXT.md`, task-graph Spec #125 |
| Multi-writer contribution under control | Packages → Store/ledger; Main books; host gates | Agent Graph + Feedback |
| Fail-closed evidence for booking | Book-path L0; severity integrity; invent-without-id | Finding Store / `finding(confirm)` |
| Hypothesis-driven *language* | mission, `work.md`, `class_probe` success, AGENTS harness-over-restriction | Steer, don’t answer-key |
| Some attack-class skills + refs | `experts/pentest/skills/*`, `refs/payloads|components|chains` | **Not** “zero knowledge”; parity vs Black-cat thickness **unmeasured** |
| Non-linear recovery | Boss loop; honest partial; booking-only tail; mandatory close-out | Feedback L0/L1 |
| Attack-surface coverage truth | surface ledger status machine | Stronger than tracker zone — coverage *of surfaces*, not *of technique families* |
| Case multi-run continuity | Handoff Truth+Next+Delivery / case_context | Beyond single skill workspace |
| Seat separation | Default never Expert Graph | Product seats |

**Implication:** Adopting Black-cat’s **markdown tracker as product SOT** would be a **regression** — learn **queue semantics**, not the file format. Adopting **zero domain content** would also be a regression — learn **thick library + thin load**, not “process only.”

### 2.3 不建议学 (do not learn / reject for product)

| # | Temptation | Why reject | Map lock |
|---|------------|------------|----------|
| R1 | Replace Graph × Pi with skill-only Claude Code harness as product kernel | Conflicts with ADR 0001, multi-tenant platform, host settlement, Default/Expert seats | **Hard reject** |
| R2 | Brand product as 「黑板架构」 | Classic blackboard ≠ us; confuses with Black-cat tracker and X comment | **Hard reject** (vocabulary) |
| R3 | Port Black-cat techniques **as gate SOT / fixed module list / expected vuln counts** | Answer-key risk; harness-over-restriction; content ages if treated as product truth | **Reject this *use*** of content — **not** reject having loadable domain knowledge (see L9–L10) |
| R3b | One-shot dump of full technique encyclopedia into system prompt | Context burden (Black-cat author’s own anti-pattern) | **Hard reject** |
| R4 | Agent-owned markdown Engagement Tracker as **gate SOT** | Bypasses host settlement; dual SOT with Store/ledger | **Reject** |
| R5 | Focused mode (no tracker) as Expert DoD | Expert structured work is Graph-only with Product state | **Reject for Expert DoD** |
| R6 | Treat author tweet/comments as proof of superiority without our lab | No shared benchmark | **Reject as evidence** |
| R7 | Classic multi-KS blackboard control as V1 runtime | Not Black-cat; not our Graph model | **Reject / defer** |
| R8 | Assume “hypothesis queue alone” yields Black-cat-like breadth | Hypothesis space is bounded by knowledge + signals | **Reject as product plan** |

---

## 3. Priority synthesis (if a future Spec map opens)

Two **parallel** Spec themes (can be one map with two workstreams, or two maps):

1. **Process — Hypothesis working memory** (L1+L2): Active/Killed/Deferred with prove/disprove/revisit on Product state; packages consume it; **no** replace Finding Store booking path.  
2. **Knowledge — Progressive technique/skills** (L6+L9+L10): thick attack-class library + signal-triggered load (max 2 active deep); restricted AD/postex/evasion; content never gate SOT or “N vulns expected.”

Then: Decision Log + stall (L3+L4); verification ritual (L5); cleanup (L7).

**Do not open** a Spec to “implement blackboard,” “merge Black-cat skill wholesale,” or “answer-key module lists.”

---

## 4. Open questions (fog for later — not decided here)

1. **Graduate P0 process + knowledge together?** Owner choice — recommended as **paired**, not either-or.  
2. **Lab / benchmark** (a) current pack, (b) + hypothesis queue, (c) + thicker progressive knowledge, (d) Black-cat skill alone — optional.  
3. **Default vs Expert:** knowledge + queue are Expert Graph-centric; Default stays lean.  
4. **L1 host-enforced vs prompt-steered?**  
5. **Cleanup ledger** scope: only `redteam_deep`?  
6. **Content parity audit:** which Black-cat technique families lack a pack skill/ref counterpart (web long-tail, AD, cloud, …) — inventory only, no auto-port.

---

## 5. One-page narrative for stakeholders

Black-cat’s public story is not “we invented the blackboard.” It is: **stop tool pipelines; run a hypothesis–evidence loop with back-edges; keep a small work board; load thick technique knowledge thinly (≤2); don’t drown the model in frameworks.** A commenter called shared memory 「黑板」 loosely.

Our product already does **honest multi-actor shared state** better (Product state, Store, ledger, Feedback, Case handoff): **what gets found can land**. That does **not** by itself expand **what the agent thinks to try**. Breadth comes from **model priors + signal-triggered domain content + tools**; process quality multiplies whatever hypothesis space those provide.

High-ROI borrowings under Graph × Pi: **(1) hypothesis lifecycle on Product state**, **(2) progressive thick skills/techniques with ruthless active-context caps**, plus Decision Log / stall / verify ritual. Not a skill-only rewrite, not a classic blackboard rebrand, not answer keys.

---

## 6. Source index

- `docs/wayfinder/research-black-cat-architecture.md` (#262)  
- `docs/wayfinder/research-platform-sot-graph-hypothesis.md` (#263)  
- `docs/wayfinder/research-blackboard-term-alignment.md` (#264)  
- Underlying primaries cited therein: `research/Black-cat/**`, `CONTEXT.md`, `docs/specs/task-graph.md`, `docs/specs/harness.md`, ADR 0001, pentest pack graphs/`work.md`  

---

## Non-goals (this ticket)

- Product code or Spec drafting beyond placement hints.  
- Reopening ADR 0001.  
- Merging Black-cat into `experts/` wholesale.  
- Closing map #261 automatically (owner may close when satisfied that destination is met).  
- Claiming measured coverage parity with Black-cat without a lab run.
