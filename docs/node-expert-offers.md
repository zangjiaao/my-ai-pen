# Node expert offers + product experts (routing)

> **Conversation model (shipped 2026-07-17):** platform has **no** peer chat Agent.  
> Default participant = Node built-in **`default`（工作台助手）**.  
> Refactor record: [`platform-default-agent-refactor.md`](platform-default-agent-refactor.md) (**done**).

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

- **1 conversation (session) = 1 Case** (work group). Scope, RoE, engagement template, and **shared findings/evidence** are conversation-scoped.
- **Expert dispatch carries `case_context`:** trimmed group **thread** + **findings_summary** + path hints (from chat/evidence) so a newly selected expert reads the case before acting. Not full tool dumps; not NLP pack invent.
- **Cross-expert handoff protocol is not required:** agents may **suggest in chat** that another expert continue; user `@` / selects the expert. No product dependency on structured handoff APIs, Case shared disk, or stations.
- Dump source/notes as **evidence** (or clear paths in chat) so the next expert sees materials via Case + `case_context`.
- Case evidence / proof (shipped): see `prd.md` + `node4-harness.md`; historical tracker [`archive/evidence-quality-plan.md`](archive/evidence-quality-plan.md).
- Historical multi-expert design notes: [`archive/multi-expert-collaboration-plan.md`](archive/multi-expert-collaboration-plan.md).
- **Active** conversation-model plan: [`platform-default-agent-refactor.md`](platform-default-agent-refactor.md).

## Dispatch gate

Before `task_assign` is sent to a worker, the platform checks that the engagement resolves to a pack id in the node’s effective offers. If not, dispatch fails with a clear error (install the pack on the node first).

`@Expert` resolution also requires:

- Expert exists and `enabled`
- Bound node still has that pack in offers (create/update API enforces this)

Aliases fold to canonical pack ids (same idea as Node4 `resolveRolePack`):

| engagement / role | pack id   |
|-------------------|-----------|
| **default**, consult, workspace | **default**（内置 seat；`consult` 迁移别名） |
| pentest, assess, verify, retest, **app_assessment**, **redteam_deep** | pentest |
| ctf, ctf-web, challenge | ctf |
| llm-security, llm, llm-redteam, agent-security | llm-security |
| code-audit, code, sast, source-audit | code-audit |
| alert-triage, soc, alert, detection | alert-triage |

**Engagement templates (RoE depth, structured UI field — not NLP):**

| Template | allow_postex | Pack |
|----------|--------------|------|
| `app_assessment` | false | pentest |
| `redteam_deep` | true | pentest |

Blank engagement / no expert selected → **`default` seat** (built-in; not offers-gated).  
Expert execution still requires pack in offers. Unset RoE defaults to **post-ex off** (conservative).

## Node pack install API

Authenticated management endpoints (billing hooks only — **no payment provider**):

- `GET /api/nodes/{node_id}/offers` — list effective offers
- `POST /api/nodes/{node_id}/experts` body `{"expert_id":"ctf"}` — install pack on node; audit `expert.install`
- `DELETE /api/nodes/{node_id}/experts/{expert_id}` — uninstall pack; audit `expert.uninstall`

Billing event detail includes stable `billing_code` (e.g. `expert.ctf`), `expert_id`, and `action` (`install` | `remove`).

Node list/detail also expose `offers` on the node payload.

## Product Expert API

- `GET /api/experts` — list instances (includes `node_name`, `node_status`, `node_offers`)
- `POST /api/experts` body `{ "name", "pack_id", "node_id", "display_name?", "description?" }`
- `GET /api/experts/{id}`
- `PATCH /api/experts/{id}`
- `DELETE /api/experts/{id}`

Rules:

- `name` is the `@mention` token: Unicode letters (including Chinese), digits, and `_.:-` (1–128), unique; must not collide with a node name. No spaces.
- `pack_id` must be installed on the bound node (offers gate).
- Cannot bind a product Expert to a non-worker / retired “platform agent” node id (if any legacy id remains during migration).
- Audit: `expert.create` / `expert.update` / `expert.delete`.
- **`default` is not** a row in `experts` (built-in seat; not user-created).

## Conversation UI

Composer is intentionally thin:

- **工作台助手 (`default`)** — default partner when no expert is selected; binds to an online Node’s built-in seat.
- **`@Expert` / 工具栏专家** — mention/picker lists product experts only (no platform Agent peer). Injects `expert_id` / `expert_name` / `engagement` / bound `agent_node_id` (structured pack from the instance, not NLP).
- **Goal mode** — optional long-task switch (+ objective). For execution experts; independent of default chat.
- No separate free-form pack picker on the composer (role comes from participant / Expert).

Right panel Status shows engagement when a **real execution** surface is active (target or work products) — not for pure default chat.

WS resolution order: **explicit participant** → expert_id / @Expert name → sticky expert (mid expert work) → **default@Node** → explicit node_id (legacy).

## Node management UI（物理节点）

- Node cards list installed **扩展包** chips.
- Node detail tabs: **概述** / **配置**（Token + 运行预算）/ **扩展**（install/uninstall packs）。
- Skills / tools 不再挂在节点上展示，改在专家名片「能力」页。

## Expert management UI（虚拟形象）

- `/experts` 卡片网格（名片）：@名、能力包、绑定节点、在线态。
- 点开详情：**概述** / **配置**（改名、绑 Node、换包）/ **能力**（pack skills + tools）。
- 多个专家可绑定同一物理节点。
- Events `nodes:changed` / `experts:changed` refresh conversation mention lists.

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
