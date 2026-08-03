# my-ai-pen

Ubiquitous language for the AI security workbench: one platform, one bound Node, expert packs, and Graph × Runtime shape.

## Language

### Product seats

**Default**:
The Node seat / pack with no Expert Graph capability (or product assistant without declared graphs): tools for ledger management, status understanding, and report assistance. Does not enter Expert Hard Graph unless a future pack declares Graph capability.
_Avoid_: treating Default as the only place continuous chat exists

**Expert**:
A specialized pack instance (e.g. pentest, CTF, code audit) addressable by @mention. Runs on a **Participant Session** for the Case. Default **work mode Free** (no Graph harness); **Expert Graph × Pi** when the pack declares graph ids and the user permits enter Graph.
_Avoid_: role seat; plugin (when meaning a full specialist pack); silent Free→Graph on resume

**Case**:
One conversation = one work group. Shares user-visible thread, Findings, evidence, scope/RoE.
_Avoid_: Case sticky template as sole work-mode authority for every Expert resume

**Participant Session**:
Long-lived `conversation_id + expert_id` work identity. Private work mode, parked Graph, working memory. Multiple Sessions may exist on one Case; v1 only the current Mention runs.
_Avoid_: new amnesiac task_id as the only notion of “session”; equating UI chat continuity with per-stage pi workdirs alone

**Work mode Free**:
Participant Session without Expert Graph runner (OMP-class Agent Runtime under the same Expert persona). UI Graph control **不指定**.
_Avoid_: Free as a second product **seat**; Soft scenario Graph; calling Free “Default” when an Expert is selected

**Node candidate**:
An implementation that can be bound as the product Node. **Product path (locked):** Node4 lineage with Graph × Pi only. Former Node5 lab tree is deleted; fallback B retired (ADR 0001 B1).
_Avoid_: dual product kernel, resurrecting node5 as bind target

### Runtime shape

**Expert Graph** (implementation synonym: **Hard Graph**):
Normative Task-stage control of **Expert** work (esp. pentest): ordered stages, fail-closed Feedback gates, stage tool profiles, Agent Graph fan-out on probe stages. Runner owns scheduling — not Main-as-scheduler. Product Expert DoD = Graph × Pi (mature graph primary; thin = lab alias only). Experts may offer **multiple Graphs**.
_Avoid_: soft scenario menu as product mode; prompt-only workflow; force_order as hints only; treating thin stub as full Expert DoD

**Soft scenario graph**:
**Retired product work mode.** Historical name for node menu + soft default_plan (Main may act). Not Expert DoD; not a third product path. Do not reintroduce on product UI or resolve.
_Avoid_: calling Soft "Expert Graph"; shipping Soft as optional Expert light path

**Agent Runtime**:
The loop that runs an agent with tools inside a graph stage or Default seat. Product packages: **pi-ai** (models) + **pi-agent-core** (loop). Product API: **Agent** + **AgentTool** + events/hooks via seam **runNode4Agent**. Not coding-agent shell, not AgentHarness, not pi-tui.
_Avoid_: calling the Graph framework itself "the Agent Runtime" when Graph and Runtime are layered; treating pi-coding-agent as required Runtime

**Graph × Pi**:
The **locked** product shape: Hard Graph orchestrates flow and gates; pi Agent Runtime runs exploration inside expert graph stages. Default seat stays outside expert hard Graph.
_Avoid_: hybrid (unqualified), soft OMP graph, Main-as-scheduler as hard Graph

**Graph model vs Graph framework**:
The model (Task / Agent / Feedback semantics) is required; a framework (e.g. Google ADK) is a replaceable implementation.
_Avoid_: "must use ADK" as a product requirement without a model reason

**Package (work package)**:
A unit of Agent Graph work Main assigns to one subagent for a stage objective (often aligned with an attack-class or coverage item).
_Avoid_: treating a batch tool call as one package; treating Todo process chores as packages

**Wave (package attempt)**:
One run of one package by a subagent from start to terminal success or failure. Retry budget is per package (product default: at most two attempts), not a stage-wide pool.
_Avoid_: calling one `packages[]` batch a wave; stage-total wave caps that starve later packages

**Batch**:
One `packages[]` (or equivalent) dispatch that may start several packages in parallel. Runtime scheduling shape, not the product unit of all-or-nothing honesty.
_Avoid_: batch = wave; batch failure as the only product settlement law

**Honest partial**:
A stage may advance when some packages succeeded and others failed, if successes are kept in handoff and failures are explicit. One package failing or exhausting its wave budget must not fail the whole stage or Graph. Silent partial (full-green coverage while work failed, including illegal L2-done over failed/unfinished packages) is forbidden.
_Avoid_: any-package-fail discards all successes; pretending failed packages were covered; one untestable surface as whole-engagement block

**Feedback L0 / L1**:
**L0** is mechanical Feedback in two lanes: **(1) stage settlement L0** — structure require + package-outcome honesty (`illegal_l2_done` / silent partial, settlement-time `running` packages) gates **stage pass/advance** (cannot silent-green); host-declared package fail is honest partial and does not alone block advance. **(2) book-path L0** — proof presence, valid severity, invent-without-id ban gate **Store ingest / confirm** (reject at ingest; no silent medium); Main re-dispatches Subagent to fix evidence — does not alone raise stage cannot-advance. **L1** is a Critic over Product state after stage L0 passes; it cannot bypass L0. **Boss loop (shared shape):** when stage Feedback fails (settlement L0 or L1 refine), control returns to Main with an actionable list; Main decides re-dispatch the same package with new instructions or abandon it and spawn a new package under a changed strategy — not runner-only engagement death on first fail, and not soft-warn advance. **L0-fail brief:** host-authored machine fields only (`illegal_l2_done`, `running_packages`, structure errors, package keys), injected into the next stage attempt via a **fixed template** (not L1 prose); Main must address each hard signal before a clean re-settlement. **Budgets are separate:** stage L0/structure uses stage attempt budget; L1 uses its own refine budget; L0 not passed ⇒ L1 does not run and does not consume L1 counts. If stage L0 honesty remains dirty after stage budget exhaust: that stage cannot pass, later **probe** stages do not run, Graph may end blocked, but a **booking-only tail** (`validate_book`-class: confirm tools only, no new probe work) still runs to land existing `feedback_ok` when possible, and engagement close-out is mandatory (disclose residual unbooked `feedback_ok`, booking-tail outcome, blocked reasons; forbid implying full coverage or process-complete success). **`blocked_with_unbooked_feedback_ok`** is a first-class residual-risk class when terminal is blocked and unbooked `feedback_ok` remain (operators / scorecards — observability only). Metrics are observability only — not a third Feedback tier.
_Avoid_: Feedback Graph as pure LLM overseer with no hard baseline; field-only Feedback with no refine loop when product wants ADK-like hybrid; conflating honest package fail with silent partial; elevating every book-path reject to stage cannot-advance; silent-stranding bookable Store rows when Graph blocks

**User interrupt (abort)**:
Cooperative cancel of the **in-flight turn** only (UI stop); not package failure; not empty-message send. In-flight packages stop; Main decides which work to keep, discard, or re-dispatch. The stage captain **working session survives** interrupt; continue is the next turn on that same logical Participant Session (same work mode Free or Graph) with retained working memory (Codex-like), not dispose-and-summary-reseed and not silent Free demotion when mode was Graph. Post-complete C1 free-in-envelope chat is distinct from incomplete Graph continue (Spec #282). Idle/no-active-burst interrupt settles Session honestly (no ghost running). Padding/steer mid-run is a separate channel that does not cancel the turn.
_Avoid_: equating abort with package-fail; destroying captain session on interrupt; empty-message-as-abort; auto-replaying the interrupted batch; treating incomplete Graph continue as post-complete free-in-envelope

**Product state (SOT)**:
Node4-owned domain truth: multi-actor session jars, Hard Graph handoff/continuity (parent lifecycle, surface ledger, structured stage results), findings/booking inputs, Feedback/settlement inputs, optional run-local **hypothesis queue**.
_Avoid_: treating LLM transcript or Agent Runtime session files as domain authority

**Hypothesis work mode**:
Optional Expert Graph capability: host-backed **hypothesis queue** while a stage has `hypothesis_work_mode: true` (missing/false = off). Pack declares availability only. Main commits lifecycle (`active` → `confirmed` \| `killed` \| `deferred`); Sub returns structured package outcomes. Not Default seat DoD; not a second booking channel.
_Avoid_: enabling from probe/explore intent alone; agent markdown tracker as gate SOT; Active → platform confirm without Store `feedback_ok`

**Hypothesis queue**:
Run-local Product-state working memory of exploration candidates and outcomes. **Not** Finding Store; **not** platform vuln ledger. Cross-Graph continuity via promote/Handoff summary + next-run re-seed only (no live multi-Graph shared queue).
_Avoid_: treating queue fullness as stage L0 gate; killed/deferred as ledger vulns

**Runtime transcript**:
Turn-local agent messages inside the Agent Runtime. Optional Node4 projection from Runtime events for debug/stream; not required as a product session format; never used as fail-closed gate input.
_Avoid_: dual cookie stores; Feedback parsing private Runtime/session formats; salvage handoff from transcript
