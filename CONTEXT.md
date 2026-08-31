# my-ai-pen

Ubiquitous language for the AI security workbench: one platform, one bound Node, expert packs, and Graph × Runtime shape.

## Language

### Tenancy

**Organization**:
One company-level tenant. Owns Users, Workspaces, Nodes, and organization policy. Does not recursively contain child Organizations.
_Avoid_: branch tree; asset Group; using Organization as the direct visibility scope for every ledger row

**Workspace**:
One flat data and execution boundary inside an Organization (e.g. branch, red team, regulated business unit). Users may belong to several Workspaces and explicitly select the current one.
_Avoid_: recursive sub-organization; project folder; Owner Ledger Group

**Workspace Membership**:
The explicit relation granting one User access to one Workspace.
_Avoid_: trusting a client-supplied Workspace id; inferring access from row creation or Case participation

**Node Assignment**:
The explicit relation allowing one Organization-owned Node to execute Cases for one Workspace. One Node may serve several Workspaces; its Experts inherit the same availability.
_Avoid_: treating an online Node connection as Workspace authorization; assigning Expert ownership independently from its Node

**Home Workspace**:
The single Workspace that owns a Case or ledger resource throughout its lifetime. User identity records the actor, not the sharing boundary.
_Avoid_: changing ownership on share; `user_id IS NULL` as shared data

**Explicit Share**:
A revocable grant from a resource's Home Workspace to another Workspace or an explicit Organization publication scope. Asset, Finding, and Intel grants are independent.
_Avoid_: implicit same-Organization visibility; row copies as sharing; Asset share automatically leaking Findings or Intel

### Product seats

**Default**:
Built-in Expert pack id (`default`): ledger management, status, report assist. **Same caste as every other Expert** — Graph eligibility is only “does this pack declare graph ids?” Built-in `default` currently declares none.
_Avoid_: treating Default as a higher/lower class of Expert; hard-coding “assistant never Graph”; treating Default as the only place continuous chat exists

**Expert**:
Any addressable pack instance (@mention), including built-in `default`. Packs differ by Profession (mission/work), tools, skills, and declared Graphs. Runs on a **Participant Session**. Work mode **Free** unless **that pack** declares graph ids and the user permits Graph × Pi.
_Avoid_: role seat as a second product type; plugin (when meaning a full specialist pack); silent Free→Graph on resume; “Default vs Expert” as Graph eligibility

**Case**:
One conversation = one work group. Shares user-visible thread, Findings, evidence, scope/RoE, and **visible group speech** (who said what — `expert_id` + pi `session_id`; not thinking, not tools). Each working runtime reads unread others’ speech via harness; **isSelf = current pi `session_id`**, not Expert catalog id. Same Expert after park-miss / Reset still sees prior visible talk from the previous runtime. A runtime does not re-ingest **this** pi session’s own talk or this-turn operator text.
_Avoid_: Case sticky template as sole work-mode authority for every Expert resume; treating the UI thread as already inside a parked Session transcript

**Participant Session**:
Long-lived `conversation_id + expert_id` work identity. Private work mode, parked Graph, working memory. Multiple Sessions may exist on one Case; v1 only the current Mention runs.
_Avoid_: new amnesiac task_id as the only notion of “session”; equating UI chat continuity with per-stage pi workdirs alone

**Housekeeping**:
Retired as a separate thin Agent. Auto-title is a **Main Task-layer** duty (still「新会话」+ authorized `scope.allow` → `platform_set_conversation_title` with `only_if_default=true`). Not a Participant Session; not a Graph-stage or Package-worker duty.
_Avoid_: a dedicated naming Session; putting title duty on Graph stage / Package workers

**Work mode Free**:
Participant Session without Expert Graph runner (OMP-class Agent Runtime under the same Expert persona). UI Graph control **不指定**.
_Avoid_: Free as a second product **seat**; Soft scenario Graph; calling Free “Default” when an Expert is selected

**Node candidate**:
An implementation that can be bound as the product Node. **Product path (locked):** Node4 lineage with Graph × Pi only. Former Node5 lab tree is deleted; fallback B retired (ADR 0001 B1).
_Avoid_: dual product kernel, resurrecting node5 as bind target

### Runtime shape

**Expert Graph** (implementation synonym: **Hard Graph**):
Normative Task-stage control of **Expert** work (esp. pentest): ordered stages, fail-closed Feedback gates, stage tool profiles (pack `graphs/hard/*.json` `tools.allow` is the stage surface — include owner-ledger inventory reads; create/enrich stay off the list), Agent Graph fan-out on probe stages. Runner owns scheduling — not Main-as-scheduler. **Main** and **Feedback** are one pi session each for the Graph run (next stage / hop = next turn); **Workers** mint a session per package. Product Expert DoD = Graph × Pi (mature graph primary; thin = lab alias only). Experts may offer **multiple Graphs**.
_Avoid_: soft scenario menu as product mode; prompt-only workflow; force_order as hints only; treating thin stub as full Expert DoD

**Soft scenario graph**:
**Retired product work mode.** Historical name for node menu + soft default_plan (Main may act). Not Expert DoD; not a third product path. Do not reintroduce on product UI or resolve.
_Avoid_: calling Soft "Expert Graph"; shipping Soft as optional Expert light path

**Agent Runtime**:
The loop that runs an agent with tools inside a graph stage or Default seat. Product packages: **pi-ai** (models) + **pi-agent-core** (loop). Product API: **Agent** + **AgentTool** + events/hooks via seam **runNode4Agent**. Not coding-agent shell, not AgentHarness, not pi-tui.
_Avoid_: calling the Graph framework itself "the Agent Runtime" when Graph and Runtime are layered; treating pi-coding-agent as required Runtime

**Graph × Pi**:
The **locked** product shape: Hard Graph orchestrates flow and gates; pi Agent Runtime runs exploration inside a pack’s graph stages. A pack without declared graphs stays Free; entry is capability + user permission, not seat caste.
_Avoid_: hybrid (unqualified), soft OMP graph, Main-as-scheduler as hard Graph; “Default never Graph” as a special-case lock

**Graph model vs Graph framework**:
The model (Task / Agent / Feedback semantics) is required; a framework (e.g. Google ADK) is a replaceable implementation.
_Avoid_: "must use ADK" as a product requirement without a model reason

**Package (work package)**:
A unit of work Main assigns to one Worker (subagent) for a single objective (often an attack-class or coverage item). Used in **Free and Graph** — Free/Graph is Main’s work mode, not a Worker type.
_Avoid_: treating a batch tool call as one package; treating Todo process chores as packages; Graph-only workers

**Package profile**:
Named Worker overlay Main may select at spawn: short role intent, tool allowlist, and default skill. Not a product Expert seat. **Product model** (decided); code today is still one generic child template + optional `skill_id`.
_Avoid_: 13 named product Experts as workers; encyclopedia always-on worker prompts; forking profiles by Free vs Graph

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
**L0** is mechanical Feedback in two lanes: **(1) stage settlement L0** — structure require + package-outcome honesty (`illegal_l2_done` / silent partial, settlement-time `running` packages) gates **stage pass/advance** (cannot silent-green); host-declared package fail is honest partial and does not alone block advance. **(2) book-path L0** — proof presence, valid severity, invent-without-id ban gate **Store ingest / confirm** (reject at ingest; no silent medium); Main re-dispatches Subagent to fix evidence — does not alone raise stage cannot-advance. **L1** is a host-spawned **Feedback Agent** (depth-1, inspect tools only) over Product state after stage L0 passes; it cannot bypass L0. Mechanical heuristics are not the product critic. After L0 pass that agent declares `l1_decision` (`pass`\|`refine`) and, on pass, `stage_advance` (`continue`\|`pause`\|`stop`). **One Feedback Agent per Graph run** (same pi session + panel row; each stage boundary is the next turn). Host **does not** NLP the instruction and **does not** HITL every stage. Missing advance vote → `continue`. Feedback’s `stage_advance` is **this hop only** (current stage → host-named next); the operator request is the user’s requirement for that hop — a later-stage pause line must not pause an earlier boundary. `pause`/`stop` only from the Feedback Agent typed field (`terminal=paused` → harness incomplete). **Boss loop (shared shape):** when stage Feedback fails (settlement L0 or L1 refine), control returns to Main with an actionable list; Main decides re-dispatch the same package with new instructions or abandon it and spawn a new package under a changed strategy — not runner-only engagement death on first fail, and not soft-warn advance. **L0-fail brief:** host-authored machine fields only (`illegal_l2_done`, `running_packages`, structure errors, package keys), injected into the next stage attempt via a **fixed template** (not L1 prose); Main must address each hard signal before a clean re-settlement. **Budgets are separate:** stage L0/structure uses stage attempt budget; L1 uses its own refine budget; L0 not passed ⇒ L1 does not run and does not consume L1 counts. If stage L0 honesty remains dirty after stage budget exhaust: that stage cannot pass, later **probe** stages do not run, Graph may end blocked, but a **booking-only tail** (`validate_book`-class: confirm tools only, no new probe work) still runs to land existing `feedback_ok` when possible, and engagement close-out is mandatory (disclose residual unbooked `feedback_ok`, booking-tail outcome, blocked reasons; forbid implying full coverage or process-complete success). **`blocked_with_unbooked_feedback_ok`** is a first-class residual-risk class when terminal is blocked and unbooked `feedback_ok` remain (operators / scorecards — observability only). Metrics are observability only — not a third Feedback tier.
_Avoid_: Feedback Graph as pure LLM overseer with no hard baseline; field-only Feedback with no refine loop when product wants ADK-like hybrid; conflating honest package fail with silent partial; elevating every book-path reject to stage cannot-advance; silent-stranding bookable Store rows when Graph blocks

**User interrupt (abort)**:
Cooperative cancel of the **in-flight turn** only (UI stop); not package failure; not empty-message send. In-flight packages stop; Main decides which work to keep, discard, or re-dispatch. The captain **working runtime is parked** (Free Main and Graph stage captain) — not disposed solely for interrupt (Spec #283 I0.9). Continue on the same Participant Session is the **next turn on that parked pi session** with retained transcript/todos/login intent (Codex-like), not dispose-and-summary-reseed. **#282 = mode continuity** (Graph not silent Free); **I0.9 = working-runtime continuity** (same runtime attach). Park miss/TTL/Node restart → honest mode-correct reseed. Post-complete C1 free-in-envelope chat is distinct from incomplete Graph continue. Idle/no-active-burst interrupt settles Session honestly (no ghost running). Padding/steer mid-run is a separate channel that does not cancel the turn.
_Avoid_: equating abort with package-fail; destroying captain session on interrupt; empty-message-as-abort; auto-replaying the interrupted batch; treating incomplete Graph continue as post-complete free-in-envelope; documenting #282 alone as full continuity

**Product state (SOT)**:
Node4-owned domain truth: multi-actor session jars, Hard Graph handoff/continuity (parent lifecycle, surface ledger, structured stage results), findings/booking inputs, Feedback/settlement inputs, optional run-local **hypothesis queue**.
_Avoid_: treating LLM transcript or Agent Runtime session files as domain authority

**Hypothesis work mode**:
Optional Expert Graph capability: host-backed **hypothesis queue** while a stage has `hypothesis_work_mode: true` (missing/false = off). Pack declares availability only. Main commits lifecycle (`active` → `confirmed` \| `killed` \| `deferred`); Sub returns structured package outcomes. Not required unless a pack Graph stage enables it; not a second booking channel.
_Avoid_: enabling from probe/explore intent alone; agent markdown tracker as gate SOT; Active → platform confirm without Store `feedback_ok`

**Hypothesis queue**:
Run-local Product-state working memory of exploration candidates and outcomes. **Not** Finding Store; **not** platform vuln ledger. Cross-Graph continuity via promote/Handoff summary + next-run re-seed only (no live multi-Graph shared queue).
_Avoid_: treating queue fullness as stage L0 gate; killed/deferred as ledger vulns

**Runtime transcript**:
Turn-local agent messages inside the Agent Runtime. Node4 also writes an **audit JSONL** per pi-agent-core instance at `workspace/case-{caseId}/expert-{expertId}/pi-{sessionId}/session.jsonl` (assembled system prompt + incremental user/assistant/tool; park continue appends). Optional event projection for debug/stream. Never Product SOT; never fail-closed gate input.
_Avoid_: dual cookie stores; Feedback parsing private Runtime/session formats; salvage handoff from transcript

**Context-window checkpoint**:
Occupancy shrink of the **next model view** on a long Participant Session (Free park / Graph same-stage): rehydrate Todo + thin Store indexes + living Intel; keep the current Todo slice; drop tool process. Not Session Reset; not `AgentHarness` compact; not making transcript the SOT. Window from model catalog (unknown model: `LLM_CONTEXT_WINDOW`); trigger default 80% (`NODE4_COMPACT_THRESHOLD`). Spec: `docs/specs/context-window-management.md`.
_Avoid_: fat chat-summary as product memory; Case-user compact slider; dumping scanner stdout into Store

### Owner ledger

**Group**:
A named assembly bucket the owner creates (公司 / 系统 / 项目). Independent of Host and Service. One assembly is Group + Host + a chosen subset of that Host’s Services. The same Host may appear in many Groups with different port subsets.
_Avoid_: single-parent folder; Host-only membership that always drags every port; Service cluster / 分身

**Host**:
An owner-enrolled address card: one primary IP or domain, plus optional aliases (child addresses). Aliases are the same machine — edited on the Host dialog (`properties.aliases`); the Host note is not identity. Distinct vhosts are distinct Hosts even if they resolve to one IP. Lookup that hits two Host ids is ambiguous: ask the user; do not pick the first row. A Host belongs to a Case when the user authorized its id as Scope, or a this-Case Surface origin uniquely matches it; harness projects living intel for those Hosts. Agent reads the projection / `fact(get)` and does not upsert a Case-private copy.
_Avoid_: auto-merging vhosts because of DNS; treating domain + public IP + internal IP as a Service-level 分身; parsing note as aliases; first-match on identity collision; assembling a Group as silent Scope; inventing a scan workflow after the user allows Hosts; inventing Hosts from recon without user ask or Case enroll_group intake

**Service**:
One network face of a Host: that Host + one port (proto is display). Durable 攻击面 hangs here. Findings hang here by host:port.
_Avoid_: path as a Service; a Service that exists without a Host; grouping Services across Hosts into a cluster

**Tag**:
A label on a Host or on a Service. Search is AND. A Host-level hit keeps the Host and, unless another tag only matches some of its Services, all of its Services; a Service-level hit keeps the Host and that Service only.
_Avoid_: business tags only on Group; inventing org structure as required clerk work

**Service 攻击面**:
Durable paths under a Service (company book). A path enters only from `finding(confirm)` or an accepted HTTP(S) Traffic settle on an existing Host. Scan / SYN does not. Not Case Surface (#368 this-run NEW/TESTED).
_Avoid_: dumping every scanned/SYN path onto the Host; calling Case Surface the company 暴露面总账; Agent creating a Host in order to hang a path

**Case Surface**:
This-Case **portrait of the unit**: Host cards first (pending Workset `t_host` = 待准入; adopted / Scope Hosts = 已准入). Path identities in `surface_ledger` hang under an admitted Host’s detail tree (NEW / TESTED coverage). Traffic settle + TARGET seed still fill paths, but only for admitted hosts — empty Scope is fail-closed. Tool HTTP (crt.sh, DoH) stays in Traffic; it is not a Host card.
_Avoid_: treating the Traffic settle tree as the Surface home; parking unauthorized CT/DNS names as TESTED coverage; Agent-invented path menus as the sitemap; treating Owner 攻击面 as this-run inventory

**Workset**:
Case-scoped **pending admission** inventory. Discovered subdomains and sibling hosts wait here (`t_host` = new host; `t_surface` = in-scope deepen). Bound next_steps click, authorize Host ids, and Surface 纳入 persist (same 0/1/2+). Agent `workset(adopt, hosts=…)` is only for still-proposed names the user typed — do not re-adopt live rows and do not call adopt to prove a bound click. Do not ask the user for a Host id. Do not adopt from recon alone. Adopt requires the Case owner; Workset/Scope writers take a Conversation row lock (`SELECT … FOR UPDATE`) so concurrent propose cannot overwrite an in-flight adopt (WS adopt/patch/propose/settle, `_remember_conversation_task` / expert sticky, HTTP Workset patch/reorder, Node `workset/adopt`, Node `asset-intake`, next-scope). HTTP Surface 纳入 also pushes `case_scope_updated` so the bound Node live/parked TaskEnvelope picks up Scope without waiting for the next dispatch. Pushes that arrive after `busy` and before `registerActiveSession` queue like `user_steer` (not while idle). Captain end parks before unregister so a 纳入 during stream dispose hits the park map; park consumes any queued Scope. Park attach keeps parked Scope when the next dispatch omits `allow`. Sticky task remember must not write a stale dispatch `scope` over the live persisted Scope. Host identity is unique primary∪alias (0 create, 1 reuse, 2+ stay proposed). No resolved Host → no Scope expand and the row stays proposed. A bound next_steps click or authorize is one persist: matching `t_host` adopt and Scope `asset_ids` commit together. If the user types names of still-proposed hosts instead of clicking, Agent calls `workset(adopt)` with those hostnames — platform does not NLP the card text. Authorize-card custom text is direction (`answered`), not authorize of bound `asset_ids`. Do not send the Agent to list_assets / a second card / ask for a Host id. Platform returns `adopted_t_host_ids` + final Scope on `user_input` and on `workset(adopt)` so the same turn can use the new Hosts. Agent `workset(set_intake)` may **record** a Case asset-intake policy (`enroll_group` + Group id) when the user asked — not inferred from keywords. Eligible `t_host` enroll into that Group and this Case Scope only after the **owner confirms** (user PUT / adopt); later propose/settle also enrolls when that policy is `set_by=user`. Exceptions (out_of_scope / low confidence / needs_authorization / invalid host) stay proposed. Remaining proposed `t_host` is user-gated — PDCA does not treat it as Agent unresolved work. Agent `workset(list)` `status=pending`/`waiting`/`admission` means `proposed`. After propose: one next_steps card. Bound click persists; typed still-proposed names use `workset(adopt)` — do not list/get to prove adoption or narrate harness continue. Workset remains the admission SoT. Surface **projects** pending `t_host` as 待准入 cards (Spec #541); that is not coverage, not an Owner Host, and not Intel hang until adopt. Names already on this Case Workset are recon memory: do not re-query CT/DNS for the same apex or narrate source HTTP status to the operator; persist source outages as this-task `fact`.
_Avoid_: a Candidate Asset product; treating Workset as a choice UI (#312 Choice Card binds ids); hanging Intel on a name that is not yet a Host; listing `next_scope_candidates` as a second SoT; treating Group membership of *other* hosts as this-Case Scope; Agent inventing Hosts from recon or from `set_intake` alone; treating `pending` as a third Workset status; paraphrasing harness continue in chat; claiming adopt when platform returned no `adopted_t_host_ids`; asking the user for a Host id; half-writing Scope while Workset stays proposed; first-match on ambiguous alias

**TESTED** (Case Surface):
Agent-maintained, Case-shared **coverage work-state** on an existing Case Surface identity. Three values: `untested` | `tested` | `skipped` (`skipped` reason `deadend` or `roe`). `surface(op=mark|unmark|skip)` takes `location` (one) or `locations[]` (many, same coverage). The captain reviews tested / untested / skipped / newly appeared, then plans and acts again. Not inferred from Traffic or MITM. Origin/root may be marked without HTTP; child paths must already sit on the tree. Persists across park/Reset with the Case row.
_Avoid_: purpose=test HTTP as TESTED; platform vuln priors as TESTED; Graph fail-closed on unmarked TESTED; operator chips for seen/touched/booked/deadend/skipped_roe as separate coverage states; putting coverage plan on per-seat Todo

**Evidence (证据)**:
Proof that **supports a Finding**. Created at `finding(confirm)` from grounded tool output. Case-shared so another expert can open the same proof. Not a notebook. Not operational leftover.
_Avoid_: treating Evidence as 情报; copying Evidence/Finding text into Intel; using chat as proof SOT

**Intel (线索 / 情报)**:
Operational notes worth keeping **while testing** (creds status, how auth works, a path to retry) on a **Host** or **Service**, written through **`fact`**. Different direction from Evidence/Finding — **do not restated booked vulns or their proof**. Agent supplies summary + NL body + hang + kind; **harness** mints `id` and stamps time/`source`/**New**/`forget_count`/`access_count`. This-task process keys stay under `facts/` (intel-source HTTP 5xx belongs here — not a Host row, not chat). After user adopt, target-stable notes (CDN, NS) may hang as Host `kind=config`. Living rows project as 线索 on **Host detail** (asset 情报 / Surface card). Case inject = Host-level plus Scope Service ports (sibling ports on the same Host omitted). The Case **Findings tab does not project 线索**. Inject places the living notebook **before** prior-finding dumps: this-Case writes + login kinds first, then by `access_count`, windowed (default 50, `MYAIPEN_INTEL_INJECT_WINDOW`). Operator 线索 is the full Scope list (same sort, no window). Summary is enough to act (recorded valid creds = login path). Correct a living clue with `fact(upsert)` on **that id**. No unused-fold / 遗忘区. Agent `forget(reason)` or user 忘记 → 已忘记 (not fed to the Agent; user restore/delete). Opening get(id) increments `access_count` (eye + number). Mid-run writes are optional; wrap/next_steps may persist only clues judged worth keeping; compact persist is a separate pass. Spec: `docs/specs/owner-intel.md`.
_Avoid_: Agent-authored timestamps or New; open `note` dump; NLP scrape; inventing a Host to hang a clue; Group/Case hang in v1; minting a second row instead of upserting the living id; a parallel `platform_record_intel` Agent surface; stuffing Finding/Evidence into Intel
