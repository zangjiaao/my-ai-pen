# Node expert offers + product experts (routing)

> **Conversation model (shipped 2026-07-17):** platform has **no** peer chat Agent.  
> Default participant = Node built-in **`default`（工作台助手）**.  
> Refactor record: shipped default model (**done**).

## Model (layers)

| Layer | What | Where |
|-------|------|--------|
| **Built-in `default` pack** | Always on every Node (not listed under 扩展) | Node4 always-on; create product Experts with `pack_id=default` |
| **Catalog pack** | Expert pack content (`pack.json`, mission/work, skills) | Shared repo `experts/` |
| **Node offers / install** | Runtime expert capability on a worker Node | Platform `node.config.offers` + Node4 install root |
| **Product Expert instance** | User-facing persona: `@name` → Node + pack | Platform table `experts` |

- A **Node** is a **container** / agent **runtime** (Node4): always **`default`**, plus zero or more installed expert packs.
- **Multiple product Experts may bind to the same Node** (shared runtime, different pack routes or labels).
- Task assignment carries **explicit structured** `engagement` / `role` / participant (from UI, Expert instance, or API). The platform **does not** invent engagement by NLP of free-text instructions.
- Remote marketplace / network hot-load of packs is **out of scope**.

### Recommended user flow

1. **Nodes** — register Node4 (default seat available immediately); install expert packs (offers) as needed.
2. **专家管理** — create Experts: `name` + `pack_id` + bind `node_id` (not required for `default`).
3. **对话（共享 session）** — 用户与 **Node 上的参与者** 在同一 conversation 协作：
   - **对话对象 = 专家管理列表**（无合成「工作台助手」）。用户在专家管理创建助理/专家（含 `pack_id=default` 通用助理）。
   - **`@ExpertName` / 工具栏选专家** → 点名该专家；系统用 Expert 的 `pack_id` 作 engagement，落到绑定 Node。
   - 可选 **Goal mode**（长任务，面向执行专家如 pentest）。

**Routing primary = product Expert**；Node 是执行座位。`default` 是 pack/seat，不是对话里的独立合成角色。

### Case (v1) — minimal collaboration

- **1 conversation = 1 Case** (work group). **Shared (user-visible):** thread, Findings, evidence, scope/target, case-wide RoE. **Not** sole authority for work mode — see **Participant Session** (`docs/specs/participant-session.md` / Spec #277).
- **Participant Session** = `conversation_id + expert_id` long session: private work mode (Free | Graph), parked Graph, working memory. Default Free (UI Graph **不指定** = Free on the wire). Graph only with declared capability + user permission. **No standalone Agent Route** pre-step — judgment to work vs propose Graph vs Expert transfer happens **inside Free** (Spec #277). Resume must not silent-divert mode via Case sticky template.
- **Expert dispatch carries `case_context`:** **findings_summary** + path hints + **speech** (id-bearing visible talk). System This turn no longer dumps `### Thread`. Unread others’ speech is harness `### Case speech` (Session cursor). Not full tool dumps; not NLP pack invent. Insufficient alone for same-Expert fail-continue — Session continuity is required (#277).
- **Cross-expert handoff (unified permission path):** Any product Expert on the Case (including `default` 平台助理) may ask to transfer to **any other** enabled Expert. Agent asks → user permits (card or free text → structured commit) → switch Mention; **new** Expert Session starts Free with Case-visible handoff summary. Direction is not one-way (assistant → execution only). User may also @ / select Expert (queued if prior Session busy). No dependency on Case shared disk or stations.
- Dump source/notes as **evidence** (or clear paths in chat) so the next expert sees materials via Case + `case_context`.
- Case evidence / proof (shipped): see `prd.md` + `docs/specs/harness.md`; historical tracker git history.
- Historical multi-expert design notes: git history.
- **Active** conversation-model plan: shipped default model + Session continuity Spec #277.

## Dispatch gate

Before `task_assign` is sent to a worker, the platform checks that the engagement resolves to a pack id in the node’s effective offers. If not, dispatch fails with a clear error (install the pack on the node first).

**Offline / unbound seat (normative — map #242 batch-2):**

- Dispatch target is the **bound Node of the selected Expert** (or explicit node for default seat). That node **must be online** (live WS in `node_connections`).
- If the bound node is offline or has no live socket: **hard fail** with a user-visible error. **No silent fallthrough** to another online worker.
- Platform `offers` alone do **not** prove disk install; see [Offline Node & pack honesty](#offline-node--pack-honesty).

`@Expert` resolution also requires:

- Expert exists and `enabled`
- Bound node still has that pack in offers (create/update API enforces this)
- Bound node is **online** when the Expert is **selected for execution** (conversation picker must not offer offline-bound Experts as selectable; backend must reject assign anyway)

Aliases fold to canonical pack ids (same idea as Node4 `resolveRolePack`):

| engagement / role | pack id   |
|-------------------|-----------|
| **default**, consult, workspace | **default**（内置 seat；`consult` 迁移别名） |
| pentest, assess, verify, retest, **app_assessment** | pentest |
| ctf, ctf-web, challenge | ctf |
| llm-security, llm, llm-redteam, agent-security | llm-security |
| code-audit, code, sast, source-audit | code-audit |
| alert-triage, soc, alert, detection | alert-triage |

**Engagement templates (RoE depth, structured UI field — not NLP):**

| Template | allow_postex | Pack | Product |
|----------|--------------|------|---------|
| `app_assessment` | false | pentest | **Yes** — Expert Graph (应用评估) |
| `redteam_deep` | true | pentest | **Yes** — Expert Graph (红队深度; hard file phase 2 / #78) |

Blank engagement / no expert selected → **`default` seat** (built-in; not offers-gated).  
Expert execution still requires pack in offers. Unset RoE defaults to **post-ex off** (conservative).

## Node pack install API

Authenticated management endpoints (billing hooks only — **no payment provider**):

- `GET /api/nodes/{node_id}/offers` — list effective offers
- `POST /api/nodes/{node_id}/experts` body `{"expert_id":"ctf"}` — install pack on node; audit `expert.install`
- `DELETE /api/nodes/{node_id}/experts/{expert_id}` — uninstall pack; audit `expert.uninstall`

Billing event detail includes stable `billing_code` (e.g. `expert.ctf`), `expert_id`, and `action` (`install` | `remove`).

Node list/detail also expose `offers` on the node payload.

**Offline install/uninstall is allowed as queue:** mutating `node.config.offers` may succeed while the node is offline. Response **must** include delivery honesty (`node_delivery.delivered`, optional `note`). Clients **must not** treat HTTP `ok: true` alone as “pack runnable on disk.” On next connect, platform pushes `expert_sync` / uninstall as today (`docs/deploy/beta-bootstrap.md`).

## Product Expert API

- `GET /api/experts` — list instances (includes `node_name`, `node_status`, `node_offers`)
- `POST /api/experts` body `{ "name", "pack_id", "node_id", "display_name?", "description?" }`
- `GET /api/experts/{id}`
- `PATCH /api/experts/{id}`
- `DELETE /api/experts/{id}`

Rules:

- `name` is the `@mention` token: Unicode letters (including Chinese), digits, and `_.:-` (1–128), unique; must not collide with a node name. No spaces.
- `pack_id` must be on the bound node’s **platform offers** (offers gate). Offline node may still hold offers as **queued** intent — create/edit Expert remains allowed as **configuration**.
- Create/edit does **not** require the bound node to be online; product UI must show **offline / not schedulable** when `node_status !== online`.
- Cannot bind a product Expert to a non-worker / retired “platform agent” node id (if any legacy id remains during migration).
- At most one Expert may have `is_default=true`. Setting a new default is serialized in the API and protected by a database partial unique index; concurrent requests resolve to one committed default.
- A default Expert must be enabled and bound to an online Node. The backend rejects ineligible or conflicting default updates.
- Audit: `expert.create` / `expert.update` / `expert.delete`.
- The built-in `default` pack is not an installable offer. A configured default conversation partner is still an Expert row marked with `is_default=true`.

## Offline Node & pack honesty

> Wayfinder map [#242](https://github.com/zangjiaao/my-ai-pen/issues/242) batch-2 · law [#250](https://github.com/zangjiaao/my-ai-pen/issues/250) · fix [#251](https://github.com/zangjiaao/my-ai-pen/issues/251) · research [#249](https://github.com/zangjiaao/my-ai-pen/issues/249).

### Product law (summary)

| Action | Offline / unpaired Node |
|--------|-------------------------|
| Register Node (row + token) | **Allowed** — registration ≠ runnable seat |
| Mutate offers (install/uninstall intent) | **Allowed as queue** — platform offers write + deferred disk sync |
| Create/edit product Expert on that node | **Allowed as config** — not schedulable while offline |
| Select Expert in conversation / @ / toolbar | **Forbidden** — grey out / disable / not selectable |
| `task_assign` / run work on that seat | **Forbidden** — hard fail; **no silent fallthrough** to another node |

### Three-state pack presentation

Platform offers **≠** “installed and runnable.” UI (节点扩展 chips/tab at minimum) **must** distinguish:

| State | Meaning | Typical signals (minimal — no new per-pack schema required) |
|-------|---------|---------------------------------------------------------------|
| **已排队 / 待同步** | Offer recorded; disk not confirmed | Node offline, or last `node_delivery.delivered === false` |
| **已同步 (可跑)** | Runtime has pack for dispatch purposes after successful online delivery/sync | Node online and last install/sync path succeeded |
| **失败** | Push/sync/uninstall delivery failed | Visible toast + 扩展 surface; not silent |

FE **must consume** install/uninstall response fields (`node_delivery`, `note`) and node online status. Do **not** label queued offers as bare 「已安装」 implying runnable.

### Dual gate

| Layer | Duty |
|-------|------|
| **FE** | 扩展 honesty (three states); Expert cards show offline/not schedulable; conversation picker **disables** offline-bound Experts |
| **API / WS** | Keep deferred offer mutate; reject execution assign when bound node offline; **never** substitute another online node for that Expert’s seat |

### Historical data

No forced migration of beta phantom offers/Experts. Ship corrects behavior via honesty + non-select + hard assign gate.

### Acceptance (implement)

1. Offline node 扩展: pack add success shows **待同步/已排队**, not runnable 「已安装」.
2. Create Expert on that node **allowed**; card shows offline / not schedulable.
3. Conversation Expert list: that Expert **disabled or not selectable**.
4. API/WS assign attempt while offline: **fails** and **does not** land on another Node.
5. Online node install still reaches **已同步** and remains usable.

### Non-goals

- Remote marketplace / network hot-load of packs  
- V1 mandatory cleanup scripts for beta rows  
- Changing register-offline token bootstrap flow  
- Per-pack persistent `sync_status` schema (optional later)

## Conversation UI

Composer is intentionally thin:

- **工作台助手 (`default`)** — default partner when no expert is selected; binds to an online Node’s built-in seat.
- **`@Expert` / 工具栏专家** — mention/picker lists product experts only (no platform Agent peer). Injects `expert_id` / `expert_name` / `engagement` / bound `agent_node_id` (structured pack from the instance, not NLP). **Experts whose bound node is offline are not selectable** (disabled/greyed); do not rely on late dispatch error alone.
- **Goal mode** — optional long-task switch (+ objective). For execution experts; independent of default chat.
- No separate free-form pack picker on the composer (role comes from participant / Expert).

Right panel Status shows engagement when a **real execution** surface is active (target or work products) — not for pure default chat.

WS resolution order: **explicit participant** → expert_id / @Expert name → sticky expert (mid expert work) → **default@Node** → explicit node_id (legacy).

### Multi-agent handoff (authorized)

- **Any product Expert** (including `default` 平台助理, and any seat with `request_user_decision`) may propose `kind=handoff` to **any other** enabled Expert listed by `platform_list_experts`, with structured `handoff_pack_id` / `handoff_expert_id` + target/scope on the card. `handoff_pack_id=default` is a valid destination — platform must apply sticky switch + `task_assign`, not silently no-op.
- **User Authorize** is required before sticky expert switch + destination `task_assign`. Cancel keeps the current seat.
- Agents call **`platform_list_experts`** first: if no product expert for that pack (or none at all), handoff is refused — no silent switch, no inventing peers. Unresolvable destination after Authorize is `handoff_failed`, not silent success.
- Destination expert owns execution confirmation and booking after handoff; default does not scan.

## Node management UI（物理节点）

- Node cards list **扩展包** chips with **honesty states** (queued / synced / failed) — not a single ambiguous 「已安装」 for offline/deferred packs.
- Node detail tabs: **概述** / **配置**（Token + 运行预算）/ **扩展**（install/uninstall packs; offline actions queue with clear copy）。
- Skills / tools 不再挂在节点上展示，改在专家名片「能力」页。

## Expert management UI（虚拟形象）

- `/experts` 卡片网格（名片）：@名、能力包、绑定节点、在线态；offline 绑定须可读为 **不可调度**。
- 点开详情：**概述** / **配置**（改名、绑 Node、换包 — 允许在 offline 节点上配置；但只有已启用且绑定 online Node 的可调度专家可设为默认对话角色）/ **能力**（pack skills + tools）。
- 多个专家可绑定同一物理节点。
- Events `nodes:changed` / `experts:changed` refresh conversation mention lists (and re-apply selectable vs disabled).

## Usage billing on complete

On `task_complete`, the platform records audit action `expert.usage` with `billing_code`, pack id, task/conversation/node ids, and status. Hooks only; no charge.

## Code map

- Catalog: `experts/` + `experts/catalog.json`
- Platform catalog load: `platform/backend/app/services/expert_catalog.py`
- Offers helpers: `platform/backend/app/services/expert_offers.py`
- Instance helpers: `platform/backend/app/services/expert_instances.py`
- Model: `platform/backend/app/models/expert.py`
- Expert API: `platform/backend/app/api/experts.py`
- Node pack API: `platform/backend/app/api/nodes.py`
- Gate + @Expert route: `platform/backend/app/ws/router.py`
- Node install/load: `node4/src/experts/`, CLI `node4/src/expert-cli.ts`
- UI: `ExpertPage.tsx`, `ConversationPage.tsx`, `NodePage` offers tab
- Tests: `tests/test_expert_offers.py`, `tests/test_expert_instances.py`

Product node line is **Node4 only**; see `docs/prd.md`.
