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

**Charting locks (map #261):** ADR 0001 Graph × Pi stays locked; technique/CVE encyclopedias are not architecture learnings; author tweet ≠ our benchmark; judgments are **value advice**, not merge commitments.

---

## Executive answer

| Question | Answer |
|----------|--------|
| What is Black-cat? | A **Claude Code skill**: hypothesis-first **state machine** + optional **Engagement Tracker** markdown SOT + ≤2 technique file routing + evidence chain. Not a multi-tenant platform; not a host Graph runner. |
| What are we? | **Node4 Graph × Pi + platform**: host-owned **Product state** (Finding Store, surface ledger, settlement, Case handoff), Hard Graph stages/packages/Feedback, hypothesis **steered** by mission/`work.md`/stage intent — not a named Hypothesis Store. |
| Is either a classic **blackboard**? | **No.** Classic = KS + shared board + control (Nii 1986). Black-cat = single-agent SM + tracker. We = blackboard-**like** multi-writer Product state under **Graph + host control**. Prefer product vocabulary; avoid 「黑板架构」 as product name. |
| Do we already “have shared state”? | **Yes — stronger than Black-cat’s tracker** for multi-actor, multi-stage, fail-closed booking. |
| Where might dig quality still learn? | **Hypothesis lifecycle visibility** (Active / Killed / Deferred with prove/disprove/revisit), **Decision Log**, **verification-mode ritual**, **stall→defer**, **cleanup ledger**, **stricter progressive skill context** — mostly **pack harness / Product-state shapes**, not kernel replacement. |

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
| **Context routing** | Signal → 1 technique file; max 2; no preload | Skills + progressive load principle; Graph stage tool profiles; risk of encyclopedia prompts | Learn **discipline**, not CVE lists |
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

| # | Mechanism | Why it may help dig quality | Priority | Where it would sit |
|---|-----------|----------------------------|----------|-------------------|
| L1 | **Explicit hypothesis queue** with Signal / Test / **Prove if** / **Disprove if** / status Active→Confirmed\|Killed\|Deferred | Agents (and Main) thrash less when candidates are structured; disproof becomes reusable knowledge; closer to author-claimed “human-like” loop | **P0** | Product state or stage-visible Store sibling (not chat); pack `work.md` + Main package framing; optional Graph settlement honesty later |
| L2 | **Disprove ≠ failure + revisit conditions** (Killed retained) | Prevents “sqlmap negative ⇒ no SQLi forever”; enables rotation with memory | **P0** | Same as L1; package terminal types / deadend notes carry revisit text |
| L3 | **Decision Log** (options / chose / why) at branch points | Improves captain strategy and post-hoc audit; boss loop today is actionable but weak on *alternatives considered* | **P1** | Stage captain Product-state log or engagement close-out appendix; not Runtime transcript as SOT |
| L4 | **Stall policy** (N rounds no progress → Deferred; time-budget re-eval) | Cuts endless OODA on one path; Black-cat’s “3 rounds” is a clear agent rule | **P1** | Pack harness + optional host soft signal on package waves / stage budget; avoid hardcoding vuln expectations |
| L5 | **Verification-mode ritual** before confirm-class work | Cheap anti-confirmation-bias prompt at VALIDATE / validate_book entry | **P1** | Pack `work.md` / book-stage prompt; do **not** replace book-path L0 |
| L6 | **Progressive technique/skill load** (default 1, max 2 active deep refs) | Author’s core claim: heavy frameworks hurt agents; sparse context helps | **P1** | Pack skill routing + harness “lean system prompt / progressive skill load” already pointed this way — **tighten enforcement** |
| L7 | **Cleanup ledger** for engagement artifacts | Matters for postex / lateral honesty and RoE close-out | **P2** | Deep graph (`redteam_deep`) + close-out fields; Default seat low need |
| L8 | **ENUMERATE bar** (e.g. ≥2 Active with disprove conditions before deep VALIDATE) | Forces hypothesis diversity before exploit tunnel vision | **P2** | Soft harness in surface→class_probe handoff language; **not** a fixed finding-count gate |

### 2.2 已具备不必学 (already covered — do not copy as-if-new)

| Mechanism | We already have | Product terms / path |
|-----------|-----------------|----------------------|
| Shared structured engagement memory vs pure chat pipeline | Product state, Store, surface ledger, host settlement | `CONTEXT.md`, task-graph Spec #125 |
| Multi-writer contribution under control | Packages → Store/ledger; Main books; host gates | Agent Graph + Feedback |
| Fail-closed evidence for booking | Book-path L0; severity integrity; invent-without-id | Finding Store / `finding(confirm)` |
| Hypothesis-driven *language* | mission, `work.md`, `class_probe` success, AGENTS harness-over-restriction | Steer, don’t answer-key |
| Non-linear recovery | Boss loop; honest partial; booking-only tail; mandatory close-out | Feedback L0/L1 |
| Attack-surface coverage truth | surface ledger status machine | Stronger than tracker zone |
| Case multi-run continuity | Handoff Truth+Next+Delivery / case_context | Beyond single skill workspace |
| Seat separation | Default never Expert Graph | Product seats |

**Implication:** Adopting Black-cat’s **markdown tracker as product SOT** would be a **regression** relative to host Product state — learn **queue semantics**, not the file format.

### 2.3 不建议学 (do not learn / reject for product)

| # | Temptation | Why reject | Map lock |
|---|------------|------------|----------|
| R1 | Replace Graph × Pi with skill-only Claude Code harness as product kernel | Conflicts with ADR 0001, multi-tenant platform, host settlement, Default/Expert seats | **Hard reject** |
| R2 | Brand product as 「黑板架构」 | Classic blackboard ≠ us; confuses with Black-cat tracker and X comment | **Hard reject** (vocabulary) |
| R3 | Port Black-cat `techniques/*.md` CVE/checklist encyclopedia into product as SOT | Content ≠ capability; ages fast; risks answer-key / tool-first behavior; AGENTS harness-over-restriction | **Reject as architecture** (optional human-curated skills later, separate effort) |
| R4 | Agent-owned markdown Engagement Tracker as **gate SOT** | Bypasses host settlement; dual SOT with Store/ledger | **Reject** |
| R5 | Focused mode (no tracker) as Expert DoD | Expert structured work is Graph-only with Product state; Focused is fine as *lab skill habit*, not product Expert path | **Reject for Expert DoD** |
| R6 | Treat author tweet/comments as proof of superiority without our lab | No shared benchmark; selection bias | **Reject as evidence** |
| R7 | Classic multi-KS blackboard control (opportunistic KS bidding) as V1 runtime | Not what Black-cat ships; not our Graph model; large redesign for unclear gain | **Reject / defer outside this map** |

---

## 3. Priority synthesis (if a future Spec map opens)

Recommended **first Spec theme** (single map, not this one):

> **Hypothesis working memory on Product state** (L1+L2): Active candidates with prove/disprove/revisit; package and stage prompts consume it; deadend/Killed retained; **no** replacement of Finding Store booking path.

Then: Decision Log + stall policy (L3+L4); verification ritual + skill load discipline (L5+L6) can be pack-only PRs without new SOT if desired.

**Do not open** a Spec to “implement blackboard” or “merge Black-cat skill.”

---

## 4. Open questions (fog for later — not decided here)

1. **Graduate P0 items to a product Spec map?** Owner choice after reading this file.  
2. **Lab / benchmark** comparing (a) current Graph × Pi pack, (b) same + hypothesis queue, (c) Black-cat skill alone — optional; not required to act on P1 pack rituals.  
3. **Default vs Expert differentiation:** Default may only need lean assist; hypothesis queue is Expert Graph-centric.  
4. **How much of L1 is host-enforced vs prompt-steered?** Host enforcement raises dig honesty but costs design; pure prompt is closer to Black-cat’s skill model (weaker guarantees).  
5. **Cleanup ledger** scope: only `redteam_deep` / postex RoE, or all Expert Graphs?

---

## 5. One-page narrative for stakeholders

Black-cat’s public story is not “we invented the blackboard.” It is: **stop tool pipelines; run a hypothesis–evidence loop with back-edges; keep a small, explicit work board; don’t drown the model in frameworks or technique dumps.** A commenter called that 「黑板」 loosely.

Our product already does the hard half of “shared board” better: **host Product state, multi-package writers, surface ledger, Finding Store, Feedback, Case handoff.** Where we are thinner is the **soft half Black-cat is loud about**: a **first-class hypothesis lifecycle** (prove/disprove/kill/defer/revisit), **decision rationale logs**, **stall discipline**, and **ruthless context sparsity**. Those are the high-ROI borrowings for **dig quality** — implemented as **harness + Product-state extensions under Graph × Pi**, not as a skill-only rewrite or a classic blackboard rebrand.

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
- Merging Black-cat into `experts/`.  
- Closing map #261 automatically (owner may close when satisfied that destination is met).
