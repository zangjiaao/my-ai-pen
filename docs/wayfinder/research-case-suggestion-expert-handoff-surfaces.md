# Research: Case suggestion + Default→expert handoff surfaces today

> Ticket: GitHub **#215** · Map **#213** (Composable Graph assembly — Route × Case Handoff × Goal)  
> Repo sources only — **no product feature code** in this resolution.  
> Date: 2026-07-28 · branch `research/case-suggestion-expert-handoff-surfaces` (base main `3378b8c`)

## Question

What **write/read surfaces** exist today for:

1. **Case-level suggestions / next-scope** (“what next”)
2. **Default → expert Route** (structured handoff that starts an execution seat)

Surface facts requested by #215:

1. `next_scope_candidates`, `case_context`, any settle/close-out hooks that emit “what next”.
2. Tools/APIs for expert handoff (`kind=handoff`, `platform_list_experts`, multi-actor todos, session jars).
3. Whether Hard Graph settle can emit next-scope (or only free path).
4. Gaps relative to product **Handoff** (Case inheritable truth) and **small-task Route** (Default→expert then expert chooses Graph/free).

**Prior research extended (not re-done):**

| Doc | Branch / note |
|-----|----------------|
| `docs/wayfinder/research-case-next-scope-inheritance.md` | `research/case-next-scope-inheritance` (#198 / map #197) — Case + next-scope spine; **not on main** at this commit |
| `docs/wayfinder/research-surface-multi-precondition-discovery.md` | #199 / map #197 — surface ledger vs next-scope; **not on main** |
| `docs/wayfinder/research-goal-mode-vs-graph-runner.md` | `research/goal-mode-vs-graph-runner` (#207) — Goal vs Hard settle fields |
| `docs/wayfinder/research-graph-vs-free-selection-today.md` | `research/graph-vs-free-selection-today` (#206) — who chooses Graph today |

This ticket **adds** Default→expert Route surfaces and a **Route vs Handoff** naming gap matrix for map #213 charting locks.

---

## Executive answer

| Surface | Write path | Read path | Maturity | Map #213 role |
|---------|------------|-----------|----------|---------------|
| **`next_scope_candidates` (T-host OOS)** | Free OMP settle only | Case `context` + UI banner + `POST …/next-scope` | **Shipped free path** | Partial **suggestion** emit — host OOS only; not full Handoff workset |
| **`attack_surface_candidates`** | Same free settle (includes in-scope) | Case context + checkpoint | **Shipped free path** | Companion to next-scope; not T-surface worklist |
| **`case_context`** | Platform on every `task_assign` from DB | Free inject + Graph prior-seed | **Shipped spine** | Closest **inheritable Case truth** channel (findings/evidence/thread) |
| **`engagement_closeout`** | Hard Graph only | Case `context` + timeline | **Shipped Hard path** | Honesty / residual Product state — **not** next-scope worklist |
| **Hard Graph `task_complete`** | `settleHardGraphTask` | Platform status | **Shipped** | **No** `next_scope_candidates` / attack-surface fields |
| **`request_user_decision(kind=handoff)`** | Default (and citizen) agent tool | Platform authorize → sticky expert + new `task_assign` | **Shipped live Route** | **Route** Default→expert (not Case Handoff schema) |
| **`platform_list_experts`** | Tool GET ledger | Agent preflight | **Shipped** | Inventory for Route card |
| **`POST /api/conversations/{id}/handoff`** | HTTP body → `case.handoff` | UI “一键选用” banner | **Shipped API + UI read** | **Passive pack suggestion** — does not auto-switch seat; **no Node tool writer** found |
| **Session jars** | `session` tool / parent↔child seed | Per-`taskDir` actors | **Shipped run-local** | Continuity **within a run**, not Case Handoff |
| **Multi-actor todos** | `plan_tree` + `owner_expert_*` merge | Tasks panel | **Shipped Case panel** | Roster merge across seats — not suggestion emit |
| **Goal auto-adopt suggestions** | — | — | **Missing** | Map Destination L3b — not present |

**One sentence:** Today **suggestions** are free-path **T-host** next-scope + Hard **close-out residual text**; **live Default→expert Route** is the authorize card (`kind=handoff`); **Case inheritable truth** is ledger + `case_context` (+ sticky task / closeout), not a unified “Handoff workset” object. Map #213’s **Route ≠ Handoff** split matches code names poorly: product “handoff” tools implement **Route**, while product **Handoff** (Case continuity) is mostly **implicit** via Case materials.

---

## 1. Case-level suggestions / next-scope (write → read)

### 1.1 Produce: free OMP settle only

| Piece | Path |
|-------|------|
| Candidate builder | `node4/src/runtime/attack-surface.ts` `buildAttackSurfaceCandidates` |
| Settle emit | `node4/src/runtime/session-runner.ts` (terminal free path) |

**Algorithm (facts):**

1. At free-path terminal settle (not chat-only / not ledger-assist), load local findings.
2. Flatten `location` / `url` / `poc` strings.
3. Parse host+port; mark `in_scope` vs task `target` + `scope.allow` hosts.
4. `attack_surface_candidates` = all hosts; `next_scope_candidates` = filter `!in_scope`.
5. Emit on harness `task_complete` (+ checkpoint `attackSurfaceCandidates`); write `taskDir/attack_surface_candidates.json` (inspect only).

**Source taxonomy today:** `source: "finding_location"` only — OOS **hosts** seen in booked finding strings. **No** T-surface / precondition / Graph-id suggestions.

Product law: `docs/specs/harness.md` — settle may attach candidates for UI next-Scope; **no mid-run asset create**.

### 1.2 Remember: platform on `task_complete`

| Piece | Path |
|-------|------|
| Hook | `platform/backend/app/ws/router.py` `_remember_next_scope_candidates` (from inbound node messages) |

**Writes on Case `conversation.context`:**

| Key | Meaning |
|-----|---------|
| `next_scope_candidates` | Prefer OOS dicts (`in_scope` false) |
| `attack_surface_candidates` | Full list when present on message |
| `next_scope_suggested` | `bool` for UI |

**Broadcast:** `type: next_scope_suggested` + `candidates` (non-blocking; no agent wait).

### 1.3 Confirm: user next-scope API

| Piece | Path |
|-------|------|
| API | `POST /api/conversations/{conv_id}/next-scope` — `platform/backend/app/api/conversations.py` `start_next_scope` |
| UI | `platform/frontend/src/pages/ConversationPage.tsx` — checkbox banner when `!running` |

**Behavior:**

1. Body: `hosts[]` (required), `register_assets` default true, optional instruction / engagement / expert override.
2. Optionally `upsert_discovered_asset` with `source="user_next_scope"`.
3. Update sticky `context.task` (target, `scope.allow`, engagement, expert sticky); clear `next_scope_*`.
4. Dispatch **new** work burst (same family as authorized handoff kickoff) — does **not** ferry old `taskDir`.

### 1.4 Hard Graph settle: **no** next-scope emit

| Piece | Path | Emits |
|-------|------|-------|
| `settleHardGraphTask` | `node4/src/runtime/hard-graph-settlement.ts` | `task_complete`: status, summary, `stop_reason`, `continue_count: 0`, `booked_findings`, `work_mode`, times, optional `llm_usage` |
| | | **No** `attack_surface_candidates` / `next_scope_candidates` / `open_goals` |

Confirmed by prior research (#198 / #207) and re-checked against main `3378b8c`.

### 1.5 Hard close-out: residual “what next” text, not next-scope API

| Piece | Path |
|-------|------|
| Build + dual-write | `node4/src/runtime/engagement-closeout.ts` + `hard-graph-task.ts` |
| Platform accept | `platform/backend/app/services/engagement_closeout.py` |
| Case store | `conversation.context.engagement_closeout` (+ timeline message) |

**Payload highlights:** `scope`, `target`, `graphId`, `terminal`, `stages[]`, `surfaces` summary, `findings` (booked / feedback_ok_unbooked / unbookable), `priors`, `feedback`, **`residual_risk`**, optional `residual_class`, `process_complete`, `blocked_reasons`.

**Read surfaces:** Case context + chat timeline. **Not** wired into `next_scope_candidates`, UI next-scope banner, or auto re-Graph.

`residual_risk` is honesty prose (open surfaces, unbooked feedback_ok, priors, process incomplete) — **human/agent readable**, not a confirmable workset.

### 1.6 `case_context` (inheritable Case materials — read-heavy)

| Piece | Path |
|-------|------|
| Builder | `platform/backend/app/services/case_context.py` `build_case_context_payload` / `load_case_context_for_conversation` |
| Attach | `platform/backend/app/ws/router.py` `_attach_case_context_to_task_assign` (also vuln-session dispatch) |
| Node parse | `node4/src/runtime/case-context.ts` |
| Free inject | `session-runner.ts` + `prompt.ts` `formatCaseContextInjection` |
| Hard Graph | `seedPriorsAtGraphStart(store, task.caseContext)` — open findings as Store priors (**proof stripped**); stage prompts use compact prior snapshot, **not** full thread/evidence board |

**Envelope (v2):** `conversation_id`, `note` (re-verify law), `thread[]`, `findings_summary[]`, `evidence_snippets[]`, `artifact_hints[]`.

**Does not include:** `next_scope_candidates`, closeout residual as structured worklist, surface ledger inventory, or suggested Graph/route.

Sticky Case keys related to multi-run (from #198 inventory, still valid):

| `conversation.context` key | Role |
|----------------------------|------|
| `task` | Sticky target / scope / engagement / expert / instruction seed |
| `case` | template, allow_postex, accounts, stations, **`handoff` blob** |
| `next_scope_*` / `attack_surface_candidates` | T-host suggestion state |
| `engagement_closeout` | Last Graph honesty snapshot |
| `participants` | Multi-role roster / per-owner plan trees |
| `checkpoint` | Last work-burst projection |

---

## 2. Default → expert Route surfaces

Map #213 charting lock: **Route** = who runs + Graph/free; **Handoff** = Case·State·Store inheritable continuity. Code and UI still use “handoff” for **seat transfer**.

### 2.1 Live Route: `request_user_decision(kind=handoff)`

| Piece | Path |
|-------|------|
| Tool | `node4/src/tools/decision.ts` `createRequestUserDecisionTool` |
| Default mission | `node4/src/roles/default.ts` — execution intent → list experts → **one** handoff card |
| Citizen base | `node4/src/roles/platform-citizen.ts` — same pattern for all packs (cross-pack) |

**Card fields (structured only):** `kind`, `handoff_pack_id`, `handoff_expert_id` / `handoff_expert_name`, `target`, `proposed_action` (scope markdown), `question`, `risk_level`.

**Preflight:** GET `/api/node/ledger/experts` — refuse card if no experts or no pack match; auto-fill first online expert for pack when id omitted.

**Emit:** platform message `type: request_decision` → UI ConfirmCard → tool blocks until authorize/cancel (timeout 15m / abort).

### 2.2 Inventory: `platform_list_experts`

| Piece | Path |
|-------|------|
| Tool | `node4/src/tools/platform.ts` `createPlatformListExpertsTool` |
| Ledger | `platform/backend/app/services/node_ledger.py` `list_experts` → `/api/node/ledger/experts` |

Returns expert id/name/pack_id/node_online + `can_handoff`. Optional `pack_id` filter on tool side.

### 2.3 Platform apply on Authorize

| Piece | Path |
|-------|------|
| Apply | `platform/backend/app/ws/router.py` `_apply_authorized_handoff` |

**On authorize (facts):**

1. Resolve enabled expert for pack (explicit id or first match; optional node hint).
2. Sticky expert via `_remember_conversation_expert`.
3. Persist target/scope from card (or best-effort URL/host extract from **card body** `proposed_action` / `question` — not free-text NLP invent of pack).
4. Optionally register host asset `source="user_authorized_scope"`.
5. Sticky task blob (`_remember_conversation_task`).
6. Broadcast `partner_switch` (UI partner chip).
7. Interrupt requester seat workers → wait idle → repair conversation status if terminal → `_dispatch_task_assign_to_node` with destination pack/expert/target/scope (`force_working=True`).

**Does not:** set `engagement_template` / `graph_execution` from the card; destination path still follows sticky Case template + C1 + Node `resolveExpertWorkPath` (see #206). **Expert does not get an explicit “choose Graph vs free” Route step** after handoff — UI/sticky template defaults dominate on pentest.

### 2.4 Passive Case pack suggestion API (not live Route)

| Piece | Path |
|-------|------|
| API | `POST /api/conversations/{conv_id}/handoff` — `suggest_expert_handoff` |
| Merge | `case_engagement.merge_case_into_context(..., handoff=…)` |
| UI | `ConversationPage` banner “建议切换专家包” + **一键选用** (selects partner; status → accepted) |

**Body:** `suggest_pack_id`, `reason?`, `artifact_ids?`, `expert_id?`, `expert_name?` → stores `case.handoff` with `status: "suggested"`.

**Explicit API law:** does **not** auto-switch pack; user confirms via @expert / send with expert_id.

**Writer gap:** no Node tool or free-path settle hook was found that **POST**s this endpoint. Only HTTP API + tests + UI **read**. Live product Route is the decision card path (§2.1–2.3), not this blob.

### 2.5 Multi-actor todos / plan trees

| Piece | Path |
|-------|------|
| Owner stamp | `platform/backend/app/services/case_participants.py` — `owner_expert_id` / `owner_expert_name` on plan nodes |
| Merge | `conversation_snapshot.merge_plan_trees_by_owner` — handoff must not wipe other role’s todos |
| PRD | `docs/prd.md` — multi-role todos by owner |

**Role for #213:** Case panel continuity across seats. **Not** a suggestion emit channel and **not** Default→expert Route.

### 2.6 Session jars (multi-actor cookies)

| Piece | Path |
|-------|------|
| Tool | `node4/src/tools/session.ts` — per-actor jars under **taskDir** |
| Seed / promote | `subagent-session-seed.ts` / `subagent-session.ts` — parent↔child within a run |

**Role:** dual-identity HTTP continuity **inside one work burst**. Not Case-scoped; next task does not inherit jars (aligned with no taskDir ferry).

### 2.7 Subagent “handoff package” (implementation term)

Runner stage/package assignment text and `subagent` tool validate a structured **package handoff** (`subagent-handoff`). Map #213: this is **runner implementation**, not product Route and not Case Handoff. Keep terminology separate in Spec writing.

---

## 3. Behavior matrix: who emits “what next”

| Emitter | When | Shape | Auto-consumed into next run? |
|---------|------|-------|------------------------------|
| Free settle | Natural stop after free OMP | OOS **hosts** on `task_complete` | Only if **user** confirms next-scope UI/API |
| Hard settle | Graph terminal | status + work_mode only | No suggestion list |
| Hard close-out | Graph terminal | residual_risk / surfaces summary / unbooked titles | Persisted on Case; **not** auto-adopted as workset |
| Goal complete / continue | Free path only; product outer continue **off** | objective status | Does not adopt next-scope or re-Graph (#207) |
| Default handoff card | Agent judgment + user Authorize | pack + expert + target/scope | **Yes** — new expert `task_assign` |
| `POST …/handoff` suggest | External/API only today | pack suggestion blob | User one-click seat select only |
| Agent chat prose | Any | free text | Not structured SOT |

---

## 4. Gaps vs map #213 Destination (Route × Handoff)

Charting locks (map body, abbreviated):

- **Handoff** = Case·State·Store **inheritable continuity** (not “swap agent” alone).
- **Route** = who runs + Graph vs free / which `graphId`.
- **Expert first Route** after Route-to-expert: Agent chooses free vs Graph; UI sticky is hint only.
- **Suggestion timing** = primarily Graph settle / round close-out; Goal may auto-adopt safe suggestions (T-host never silent).

### 4.1 Relative to product **Handoff** (Case inheritable truth)

| Needed (Destination) | Today | Gap |
|-----------------------|-------|-----|
| Case multi-run SOT for adopted next work | Sticky `task` + findings ledger + closeout snapshot | **No** durable multi-type suggestion workset (T-surface + T-host + Graph-id) |
| Inherit truth without taskDir ferry | **`case_context` + citizen tools** | Shipped spine — **extend**, not replace |
| Graph settle → Case suggestions | Closeout residual only | **Hard path does not emit** confirmable next-scope |
| Naming | Tools/API named “handoff” mean seat transfer | Spec must rename carefully: code **handoff** ≈ **Route**; Case continuity ≈ **case_context / ledger / closeout** |

### 4.2 Relative to **small-task Route** (Default→expert → expert chooses Graph/free)

| Needed (Destination) | Today | Gap |
|-----------------------|-------|-----|
| Default → expert | **Shipped** authorize card + dispatch | OK as live Route spine |
| Expert chooses Graph vs free after arrival | UI defaults pentest to `app_assessment`; platform sticky template; Agent **does not** judge path (#206) | **Missing** Agent Route judgment step; sticky template is force, not hint |
| Structured Route wire (`graph_execution`, `graphId`, expert) after judgment | C1 + template only | No Route outcome object from Agent |
| Small-task free path on expert without Graph | Exists as free OMP when no hard intent / chatOnly / continue | Not exposed as expert Mode chip; easy to full-Graph on seat pick |

### 4.3 Seams to **extend** vs invent

| Extend | Invent later (not present) |
|--------|----------------------------|
| Free next-scope produce/remember/confirm loop | Hard settle next-scope family emit |
| `case_context` attach + prior seed | Case schema for T-surface / confirmed workset |
| `kind=handoff` Route card + `_apply_authorized_handoff` | Post-expert Agent Route (Graph/free/`graphId`) structured fields |
| Closeout residual as **input** to suggestion generation | Auto Goal adopt-until-empty loop |
| Passive `case.handoff` API if still wanted for non-card suggest | Node writer for `POST …/handoff` (only if product keeps dual channels) |

### 4.4 Seams **not** to invent

| Temptation | Why reject (existing law) |
|------------|---------------------------|
| Keyword/NLP invent engagement or Route | AGENTS.md / platform structured-only |
| Ferry taskDir / session jars as Case Handoff | harness + expert-offers: Case materials only |
| Silent host create from OOS candidates | User Authorize / next-scope / asset page only |
| Treat subagent package “handoff” as product Handoff | Implementation term inside one Graph run |
| Second Case model / workstation disk | Case = conversation already |

---

## 5. Primary-source index (absolute paths)

| Area | Paths |
|------|--------|
| Free next-scope produce | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/session-runner.ts`, `attack-surface.ts` |
| Hard settle | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/hard-graph-settlement.ts` |
| Close-out | `/mnt/d/Coding/my-ai-pen/node4/src/runtime/engagement-closeout.ts`, `hard-graph-task.ts` |
| Platform next-scope remember/API | `/mnt/d/Coding/my-ai-pen/platform/backend/app/ws/router.py`, `api/conversations.py` |
| case_context | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/case_context.py`, `node4/src/runtime/case-context.ts` |
| Case engagement / handoff blob | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/case_engagement.py` |
| Closeout accept | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/engagement_closeout.py` |
| Decision + list experts | `/mnt/d/Coding/my-ai-pen/node4/src/tools/decision.ts`, `platform.ts` |
| Default / citizen roles | `/mnt/d/Coding/my-ai-pen/node4/src/roles/default.ts`, `platform-citizen.ts` |
| Authorize handoff apply | `/mnt/d/Coding/my-ai-pen/platform/backend/app/ws/router.py` `_apply_authorized_handoff` |
| UI banners | `/mnt/d/Coding/my-ai-pen/platform/frontend/src/pages/ConversationPage.tsx` |
| Session jars | `/mnt/d/Coding/my-ai-pen/node4/src/tools/session.ts` |
| Multi-owner todos | `/mnt/d/Coding/my-ai-pen/platform/backend/app/services/case_participants.py`, `conversation_snapshot.py` |
| Product law | `/mnt/d/Coding/my-ai-pen/docs/specs/harness.md`, `docs/prd.md`, `docs/specs/task-graph.md` |

---

## 6. Resolution for #215

**Answer:** Write/read surfaces are inventoried above. Free path owns **T-host next-scope**; Hard path owns **close-out residual** without next-scope candidates; Default→expert **Route** is the authorize card + platform dispatch; Case **inheritable truth** is ledger + `case_context` (+ sticky task/closeout), not a unified Handoff workset. Gaps for map #213 are Hard suggestion emit, multi-type Case workset, and Agent Graph/free Route after expert arrival.

No product code changes in this ticket.
