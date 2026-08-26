# Spec: Case · Participant Session · work mode continuity

**Status:** Implementable Spec (product contract)  
**Issue:** [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) (amended by [#282](https://github.com/zangjiaao/my-ai-pen/issues/282) mode continuity on interrupt→continue; [#283](https://github.com/zangjiaao/my-ai-pen/issues/283) I0.9 working-runtime continuity; [#354](https://github.com/zangjiaao/my-ai-pen/issues/354) Session owns runtime — Task package settle does not dispose captain; [#474](https://github.com/zangjiaao/my-ai-pen/issues/474) composer restore on Case remount)  
**Inputs:** Owner grilling (session analysis `0ab49d25-…`; Free→Graph silent divert; Case vs Session continuity); owner resolution vs map [#213](https://github.com/zangjiaao/my-ai-pen/issues/213) (2026-08-03); field Case `f758d7f5-…` (Graph interrupt → Free cold-start / working-runtime amnesia)  
**Product path:** Graph × Pi + Product state (ADR 0001). Soft scenario Graph remains **retired**.  
**Amends:** `docs/specs/task-graph.md` product rule “Expert = Graph only / no Expert free chip”; `docs/specs/expert-offers.md` Case sticky template as sole mode authority; interrupt continue continuity (#282 mode + #283 I0.9 park/attach).  
**Supersedes (product law):** map [#213](https://github.com/zangjiaao/my-ai-pen/issues/213) / grilling [#216](https://github.com/zangjiaao/my-ai-pen/issues/216) **standalone Agent Route** (`route_target` as a mandatory pre-work judgment step that may alone select `hard_graph` under 不指定). Continuity and mode authority follow **this Spec**. Reusable pieces of #213 (Case multi-run inheritance schema, Goal adopt families, multi-`graphId` catalog facts) may still feed later Specs — they must not reintroduce silent or Agent-alone Graph divert.  
**Does not amend:** book-path L0, Finding Store, hypothesis queue ≠ booking, intent NLP ban (`AGENTS.md`).

---

## 1. Purpose

Give operators a continuous conversation contract:

> **@ whom you address is whose Participant Session you talk to.**  
> **Case shares what the user can see.**  
> **Graph is an on-demand capability (harness), not a silent platform divert.**  
> **While a Session is working, changes queue unless the user force-sends.**  
> **No separate Agent Route step — the Expert works in Free first; Graph and Expert transfer are rare, permissioned events.**

Kill the failure mode where failed Free work + user「继续」is rebuilt as full Expert Graph from `init` because Case sticky `engagement_template` / UI defaults overrode Session work mode.

Also kill a second-class product path where a pre-flight **Route** moment alone writes `hard_graph` while the user still sees 不指定 — that breaks Session continuity and multiplies Handoff ceremony.

---

## 2. Vocabulary

| Term | Definition |
|------|------------|
| **Case** | One conversation = one work group. Shared: user-visible thread, Findings (ledger), evidence, scope/target, RoE fields that are case-wide (e.g. allow_postex when set). |
| **Participant Session** | Long-lived work identity: **`conversation_id + expert_id`** (product Expert instance). Private: work mode, Graph harness state (active / parked), working memory (surface intent, unbooked candidates, login intent, harness todos). |
| **Work mode Free** | Session runs **without** Expert Graph runner. Same Expert persona; OMP-class Agent Runtime loop. **Not** the Default seat; **not** retired Soft scenario Graph. |
| **Work mode Graph** | Session runs Expert Graph × Pi for a **declared** graph id (`app_assessment`, `redteam_deep`, …). |
| **Graph capability** | Pack/Expert declares which graph ids it may run. Missing declaration ⇒ cannot enter Graph. No seat special-cases (“assistant never” as hard code) — only capability tables. |
| **Unspecified (UI)** | Graph composer value **不指定** = omit / free-alias on the wire: **no force mode change** (Spec #278 A1). First turn / Free Session → Free; if Session already Graph, stay Graph. Not “Agent may silently pick Graph”. Exit Graph needs permission card. Agent may **suggest** enter Graph; user must permit. |
| **Permission event** | Explicit user acceptance to change work mode, transfer Expert, resume parked Graph vs full restart. Via standard card and/or free-text understood by **current** Session Agent then structured commit. Platform code does **not** NLP-invent mode. |
| **Queue** | While Session has in-flight work, user changes (message, Graph control, Mention, **ChoiceCard confirm**) wait unless **force send / interrupt** on the queue chrome. **FIFO** — confirm is the same class as user text (no decision priority). Cap **5** pending / Case. Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313). |
| **Parked Graph** | After exit Graph → Free, Graph stage pointer and harness progress are **suspended**, not wiped. Later re-entry: Agent suggests continue vs full restart; user confirms. |
| **Expert transfer** | Cross-Expert in either direction (including to `default` 平台助理): ask → user permit → switch Mention; receiving Session starts Free + Case-visible summary. Prefer **same Expert** continuing in Free/Graph over transfer. |
| **Case multi-run inheritance** | (Optional later Spec / #213 residue) Truth + next-work projections across Graph **rounds** for the same Case — **not** the same word as Expert transfer. Never named bare “Handoff” without qualifier. |

_Avoid:_ free mode as a second product **seat**; Soft scenario Graph; platform keyword tables inventing engagement/mode; Case-level sticky template **overwriting** Session mode on resume; **standalone Agent Route** pre-step that alone selects Graph; bare “Handoff” meaning both Expert transfer and Case multi-run inheritance.

---

## 3. Normative rules (decisions D1–D23)

### 3.1 Identity and sharing

1. **Session identity** = `conversation_id + expert_id` (long session per Expert on the Case).  
2. **Case shared** = what the user sees (thread, Findings, evidence) **and** visible group speech in `messages` (append-only). Thinking and tool process are not Case speech.  
3. **Session private** = work mode, harness, non-ledger working memory, **speech cursor** (last scanned Case speech id).  
3a. **Group speech to a Session** = unread others only, via harness `### Case speech`. Speech lines carry **who** (`expert_id`) and **which working runtime** (`session_id` = pi `Agent.sessionId`). **isSelf = current pi `session_id`**, not Expert catalog id — same Expert after park-miss / Reset / new `pi-*` still sees prior visible talk. This runtime does not re-read **its own** replies or this-turn operator text. Park-hit is incremental; do not dump 1–3 then 1–4. Operator lines may stamp mention `expert_id` (who they addressed); that must not mark the line as self.  
4. **v1 concurrency** = round-robin: only the **current Mention** Session may run. Multiple Sessions may exist; they do not run true-parallel product work in v1.

### 3.2 Work mode authority

5. **Default / first turn** with no Session Graph = Free **on the wire**. UI「不指定」= **no force mode change** (Spec #278 A1): Free Session stays Free; Graph Session stays Graph. There is **no** mandatory T1 Agent Route that may alone emit `hard_graph`.  
6. **Mode follows** last user-permitted or user-selected value for **that Session** — never silent rewrite on resume, failed continue, or Case sticky template alone.  
7. **Enter / exit Graph** = permission events. Agent may **propose** from Free (or mid-Session); must not divert without permission. User explicit Workflow selection this turn is also permission.  
8. **Exit Graph** → Free; Graph state **parks**. Re-enter: Agent recommends continue-parked vs full restart; user confirms.  
9. **Same-mode continue** (e.g. LLM 500 then「继续」) = resume **same** Session and work mode; **no** permission card; **no** Route re-judgment that changes mode.  
10. **Graph list** = capability declaration on pack/Expert; UI options, Agent proposals, and platform validation share one source.  
10a. **Prefer Free continuity:** the Expert **does the work in Free** unless the user chose a Graph Workflow or accepted an enter-Graph proposal. Judgment “do I dig / plan / ask user / transfer Expert?” happens **inside Free** (normal Agent loop), not in a separate Route kernel. Free is OMP (Main may self-act); host PDCA settle (Spec [#519](https://github.com/zangjiaao/my-ai-pen/issues/519)) only vetoes false completion from Product state — it is not Graph Feedback and not a “Main must only dispatch” rule.  
10b. **Minimize Expert transfer:** transfer only when the current pack truly cannot serve; same-Expert Free (and optional later Graph with permission) is the default path.  
10c. **Graph catalog + dual-rail UI:** product Graph L1 (skill-like) and composer vs AgentRow separation — Spec [#278](https://github.com/zangjiaao/my-ai-pen/issues/278) / `docs/specs/graph-catalog-work-mode-ui.md`.

### 3.3 Permission UX

11. **Permission** = standard option cards ∪ natural language.  
12. **Cards:** current Session Agent requests permission; platform renders **standard shell** (enter Graph / exit Graph / handoff / continue-parked vs restart). Platform does **not** auto-pop “enter Graph?” on resume/fail.  
13. **Natural language:** interpreted by **current** Session Agent; Agent commits **structured** decision. Platform does not regex-map「可以」→ mode.  
14. **UI Graph control** includes **不指定** (user intent: no force mode change). Dual-rail: composer = user preference; AgentRow = Session actual (Spec #278). Sync composer only after mode settlement. **Remount / Case open:** restore composer partner from Case current Mention and Graph from **that** Session — not Case sticky template, not a browser-global last pick (Spec [#474](https://github.com/zangjiaao/my-ai-pen/issues/474) / `composer-case-restore.md`). Composer has no Goal chip.  
14a. **Handoff / authorization wait (simple path):** Session tells platform it needs user approval → platform **displays** the card and **forwards user feedback** to the **current Session** only. Clicking Authorize/Cancel and **typing a reply** are the **same feedback path** (not a second task, not a speaker switch). Platform does **not** interpret approve/cancel semantics. After any user feedback, the card is **skipped / greyed** (no second click). **Speaker label** = current Participant Session (header/Mention); `handoff_expert_*` is card content only — never top-level `expert_name` on the waiting turn.

### 3.4 Queue and Mention

15. **In-flight work:** new user demand (text, Graph control, Mention change, **ChoiceCard confirm / next_steps selection**) **queues** as one FIFO class.  
15a. **Confirm delivery (Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313)):** live approval wait → forward into current Session; dead wait / busy / restart → enqueue or continue dispatch with full confirm text + sticky target/scope/expert — **not** empty-target chat-only bypass.  
16. **Force send / interrupt** on queue chrome: interrupt current turn, then apply new demand (same as single-Agent new goal under interrupt). User may **delete** queue items before delivery.  
16a. **Queue chrome (list-tail):** queued user text sits **below** list-tail `工作中...`, same bubble shape as user history, **secondary type** (`text-ink-muted`). Actions: **发送** / **编辑** / **取消**. **发送** = force interrupt then apply that demand; the row stays queued until platform `session_demand_drained`, then **becomes a normal user bubble** (no optimistic promote). **编辑** deletes the queued demand and overwrites the composer draft with that text. **取消** deletes the demand and drops the row (no cancelled ghost). **编辑** / **取消** stay available on *other* rows while a force-send is in flight; the row already taken for force-send cannot be cancelled or edited (lock clears on drain, idle, Case switch, or terminal settle). Queue-full does not grey ChoiceCards. Live approval wait (authorize/handoff/`confirm_options` forward) still sends; only a busy enqueue is refused without finalizing the card. Rejected text is restored to the composer. Per Case, at most **5** pending demands.  
17. **Mention change** only retargets **subsequent** routed messages; does not alone kill the running Session (unless force interrupt).  
18. **Expert transfer:** any Participant Session may ask to transfer to any other enabled Expert (including `default` 平台助理). Ask → user permit → switch Mention; **new** Expert Session starts **Free** with Case-visible summary; new Expert enters Graph only via its own permission path. Not a mandatory assembly step before every task. Not assistant→execution only.

### 3.5 Continuity on harness switch

19. Free ↔ Graph switch = **change harness, not person**: keep Session identity and retained working memory (dialogue, goals, surfaces, unbooked candidates, login intent, Case Findings).  
20. May reset/park: Graph stage pointer, stage-shaped todos, active vs full graph entry point.  
21. Must **not** implement exit Graph as “new amnesiac pi tree that drops Session memory.”

### 3.6 Intent rules (unchanged)

22. Platform maps **already explicit** structured fields only. No free-text invent of engagement / work mode / graph id.  
23. Agent (LLM) may understand user text **inside** its Session and emit structured tools/decisions.

---

## 4. Product seams (test at highest seam)

**Primary seam (prefer one):** **Participant work envelope resolver**

**Code:** `platform/backend/app/services/participant_session.py` (`resolve_work_envelope` + `apply_work_envelope_to_task_assign`). Wired from `platform/backend/app/ws/router.py` (`_apply_participant_work_envelope` on every `task_assign`). Session private fields: `conversation.context.sessions[expert_id].{work_mode,graph_id,parked_graph}`.

Input (structured only): Case id, active Mention `expert_id`, Session record (work mode, parked graph, running?), user action (message | card decision | composer graph value | force_interrupt), capability table.

Output: immutable **work envelope** for this dispatch:

- `expert_id`, `work_mode` (`free` | `graph`), `graph_id?`, `graph_execution` (`run` | `continue_session` | `resume` | `resume_parked` | `full_restart`), `queue` (`enqueue` | `run_now`), `permission_required?`

Consumers: platform WS/task_assign path, composer, Node entry. **No second policy** in Node that re-derives mode from Case sticky template alone.  
**No separate Route resolver** that runs before Free and may alone set `work_mode=graph`.

**Secondary (thin adapters only):** UI Graph control values; standard permission card kinds; Node Free vs Graph runner bind.

### 4.1 Relation to map #213 (Composable Graph assembly)

| #213 idea | Under this Spec |
|-----------|-----------------|
| Standalone **Agent Route** (T1 mandatory free vs `hard_graph`) | **Rejected** as product law. Free Session **is** the judgment loop. |
| User explicit Workflow | **Kept** — highest priority enter Graph (permission). |
| UI sticky force Graph | **Rejected** (same as before). |
| Case Handoff Truth/Next multi-run | **Optional later** inheritance Spec; rename away from bare “Handoff”; does not gate every Free turn. |
| Goal multi-round / Next-Scope families | **Out of this Spec’s DoD**; if built later, must not silent-set Graph or skip permission / Session continue rules here. |
| Multi-`graphId` catalog | **Kept** as capability table input to permission + UI. |

---

## 5. Acceptance bars

| # | Bar |
|---|-----|
| A1 | Failed Free Session + user「继续」resumes **Free** same Participant Session; does **not** start Expert Graph from `init` solely due to UI default / Case sticky template. |
| A2 | Composer **declared graph id** this turn ⇒ Graph (explicit permission). Composer **不指定** ⇒ **no force mode change** (Free Session stays Free; Graph Session stays Graph — Spec #278 A1). |
| A3 | Enter/exit Graph without permission event does not change work mode. |
| A4 | Exit Graph parks harness; Session remains addressable in Free; re-enter offers continue vs restart via Agent + user confirm. |
| A5 | Expert transfer: new Expert Free + Case-visible summary; no inherited Graph stage machine. |
| A6 | In-flight: Graph/Expert changes enqueue; force interrupt applies new demand. |
| A7 | Platform has no keyword table that sets `work_mode` / `graph_id` from free text. |
| A8 | Pack without graph capability never surfaces enter-Graph options. |
| A9 | Under UI 不指定: first turn / Free Session stays Free; Graph Session continues Graph. Enter Graph only via explicit Workflow or accepted enter-Graph permission — **no** Agent-alone `hard_graph` Route write. |
| A10 | No mandatory pre-work Route step in the product path; judgment to work vs propose Graph vs propose Expert transfer happens inside Free. |

### 5.1 Interrupt → continue — mode continuity (Spec [#282](https://github.com/zangjiaao/my-ai-pen/issues/282))

Primary seam: **Participant Session continue after interrupt**. Free and Graph are work modes on the **same** Session (`conversation_id + expert_id`); interrupt cancels **only the in-flight turn**.

**Split:** **#282 = mode continuity** (Graph must not silent-become Free cold OMP via C1 wire collision). **#283 I0.9 = working-runtime continuity** (park captain; continue = next turn on same pi session). Both required for full operator expectation; #282 alone is half product.

| # | Bar |
|---|-----|
| I1 | Graph mid-work → interrupt → user「继续」(composer 不指定/omit) → `work_mode` stays **graph**; next turn is **not** Free cold OMP. |
| I2 | Same-mode continue retains harness todos/plan projection authority (no wipe-to-empty solely due to continue). **Platform:** Graph envelope not stripped on continue. **Node I0.9:** park Free Main and Graph stage captain; attach same runtime on continue so todos are not wiped-to-empty by continue alone. Park miss → mode-correct reseed (Hard for incomplete Graph). |
| I3 | Credential/login intent (structured `accounts` and/or Session working memory) remains available on the next turn (I0.9 park retains accounts snapshot). |
| I4 | Free Session + incomplete +「继续」+ Case sticky Graph template stays **Free** (A1). Free Main parks the same way as Graph (I0.9). |
| I5 | Graph **completed** + follow-up chat (C1) remains free-in-envelope; **no** full Hard stage re-fire. C1 must not consume a Graph park as incomplete resume. |
| I6 | Incomplete / interrupted / failed Graph continue must **not** take the C1 free-in-envelope path (I5). Wire adapters must not collapse these into one synonym Node treats as Free. |
| I7 | Interrupt when Node already idle / no active burst settles Session (no permanent ghost running); subsequent「继续」follows I1/I4 by Session mode. |
| I8 | Explicit composer graph id this turn still may enter Graph (permission); continuity rules do not break intentional Workflow. |

**Wire adapter (implementation):** post-complete C1 uses `graph_execution=continue` (free-in-envelope). Incomplete Graph same-mode continue uses `graph_execution=resume` (Hard Graph path). Platform `resolve_work_envelope` + Node `parseGraphExecution` / `resolveExpertWorkPath` are thin adapters under this seam.

### 5.2 Working session continue — runtime continuity (Spec [#283](https://github.com/zangjiaao/my-ai-pen/issues/283) I0.9)

Primary seam: **Working session continue after interrupt**.

| # | Bar |
|---|-----|
| I0.9-W1 | Graph stage captain mid-work → interrupt →「继续」→ attach **same** parked captain runtime; `work_mode` graph; not Free cold OMP. |
| I0.9-W2 | Pre-interrupt non-empty todos/plan remain non-empty after continue alone (no wipe-to-empty before agent acts). |
| I0.9-W3 | Credential/login intent available on next turn after park attach. |
| I0.9-W4 | Free Main mid-work → interrupt →「继续」→ attach same Free Main parked runtime (not Graph-only park). |
| I0.9-W5 | Graph completed + C1 follow-up unchanged (#282 I5). |
| I0.9-W6 | Park miss → mode-correct Graph reseed; never silent Free demotion when Session mode was Graph. |
| I0.9-W7 | Idle interrupt → honest settle; continue by Session mode (#282 I7). |
| I0.9-W8 | Steer/padding mid-run ≠ interrupt; does not dispose or park. |
| I0.9-W9 | Park TTL: Spec [#354](https://github.com/zangjiaao/my-ai-pen/issues/354) L2 retires idle park TTL as product Session death (default disabled). Explicit TTL may still be used for tests/ops; process death → honest mode-correct reseed. |
| I0.9-W10 | Explicit composer Graph after Free may enter Graph (permission); Free park is not forced onto Graph (mode_mismatch reseed). |

**Node adapter:** `working-session-park` registry keyed by `conversation_id + expert_id`. Interrupt **and Task package settle/error** park captain (Spec #354); continue attaches. Dispose only on Case close / Session delete / expert transfer / explicit manual end (whitelist); process death → honest reseed. Idle park TTL is not product Session death (L2).

---

## 6. Living doc maintenance

When implementing, update in the **same change**:

- This file (if contract shifts)  
- `docs/specs/task-graph.md` (Expert Free work mode + UI 不指定)  
- `docs/specs/expert-offers.md` (Case share vs Session mode; handoff)  
- `docs/specs/composer-case-restore.md` (composer chips after remount — #474)  
- `CONTEXT.md` only if ubiquitous language needs Participant Session / work mode Free  
- `docs/README.md` index (link present)

---

## 7. Out of scope

- True multi-Expert parallel execution on one Case  
- Soft scenario Graph revival  
- Dual product kernel / Node5  
- Hypothesis queue as booking channel  
- Findings **count** as success metric  
- Platform NLP engagement invent  
- Full pi session file format as Product state SOT (Product state remains host SOT; Runtime transcript subordinate). Host layout `workspace/case-{caseId}/expert-{expertId}/pi-{sessionId}/` is inspect, not SOT.  
- Standalone Agent Route kernel / mandatory T1 `route_target` pre-step (#213 L3a as originally grilled)  
- Full Goal multi-round assembly Spec (may reference Session rules later)  
- Case multi-run inheritance field schema (former #217) as a blocker for Free Session continuity
