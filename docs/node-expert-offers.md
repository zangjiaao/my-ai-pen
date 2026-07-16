# Node expert offers + product experts (routing)

## Model (three layers)

| Layer | What | Where |
|-------|------|--------|
| **Catalog pack** | Pack content (`pack.json`, mission/work, skills) | Shared repo `experts/` |
| **Node offers / install** | Runtime capability on a worker Node | Platform `node.config.offers` + Node4 install root |
| **Product Expert instance** | User-facing persona: `@name` → Node + pack | Platform table `experts` |

- A **Node** is a **container** / expert-pack **runtime** (Node4), not one fixed product expert forever.
- **Multiple product Experts may bind to the same Node** (shared runtime, different pack routes or labels).
- Task assignment still carries **explicit structured** `engagement` / `role` (from the Expert instance or API field). The platform **does not** invent engagement by NLP of free-text instructions.
- Remote marketplace / network hot-load of packs is **out of scope**.

### Recommended user flow

1. **Nodes** — register Node4; install expert packs (offers).
2. **专家管理** — create Experts: `name` + `pack_id` + bind `node_id`.
3. **对话（共享 session）** — 用户、平台 Agent、多位专家在同一 conversation 里协作：
   - **不 @** → 跟平台 Agent 聊（解释资产/漏洞/进度）；平台可代为分发任务给专家。
   - **`@ExpertName`** → 在同一会话里点名该专家（渠道，不是另一套任务系统）；系统用 Expert 的 `pack_id` 作 engagement，落到绑定 Node 执行。
   - 可选 **Goal mode**（长任务）。

**Routing primary = Expert**（用户可见参与者）；Node 只是执行座位。Sticky 字段：`expert_id` / `expert_name` / `engagement` 一并粘住，派发时不得丢 pack。

平台代为分发（用户未 @）时：按 capability→pack 自动选择已启用 Expert 实例，再落到其 Node；若无实例，仍写入 structured `engagement`（避免 Node4 bare `runtime`）。

### Case (v1) — minimal collaboration

- **1 conversation (session) = 1 Case** (work group). Scope, RoE, engagement template, and **shared findings/evidence** are conversation-scoped.
- **Expert dispatch carries `case_context`:** trimmed group **thread** + **findings_summary** + path hints (from chat/evidence) so a newly selected expert reads the case before acting. Not full tool dumps; not NLP pack invent.
- **Cross-expert handoff protocol is not required:** agents may **suggest in chat** that another expert continue; user `@` / selects the expert. No product dependency on structured handoff APIs, Case shared disk, or stations.
- Dump source/notes as **evidence** (or clear paths in chat) so the next expert sees materials via Case + `case_context`.
- Full plan: [`multi-expert-collaboration-plan.md`](multi-expert-collaboration-plan.md).

## Dispatch gate

Before `task_assign` is sent to a worker, the platform checks that the engagement resolves to a pack id in the node’s effective offers. If not, dispatch fails with a clear error (install the pack on the node first).

`@Expert` resolution also requires:

- Expert exists and `enabled`
- Bound node still has that pack in offers (create/update API enforces this)

Aliases fold to canonical pack ids (same idea as Node4 `resolveRolePack`):

| engagement / role | pack id   |
|-------------------|-----------|
| pentest, assess, verify, retest, **app_assessment**, **redteam_deep** | pentest |
| ctf, ctf-web, challenge | ctf |
| consult | consult |
| llm-security, llm, llm-redteam, agent-security | llm-security |
| code-audit, code, sast, source-audit | code-audit |
| alert-triage, soc, alert, detection | alert-triage |

**Engagement templates (RoE depth, structured UI field — not NLP):**

| Template | allow_postex | Pack |
|----------|--------------|------|
| `app_assessment` | false | pentest |
| `redteam_deep` | true | pentest |

Blank engagement defaults to **pentest** (must still be offered). Unset RoE defaults to **post-ex off** (conservative).

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
- Cannot bind to the platform agent node.
- Audit: `expert.create` / `expert.update` / `expert.delete`.

## Conversation UI

Composer is intentionally thin:

- **`@Expert`** — mention picker lists product experts (+ platform agent). Selecting an expert injects `expert_id` / `expert_name` / `engagement` / bound `agent_node_id` (structured pack from the instance, not NLP).
- **No mention** — platform Agent is the default room participant (explain / dispatch).
- **Goal mode** — optional long-task switch (+ objective). Independent of expert routing.
- No separate “Expert role” pack picker on the chat composer (role comes from the Expert).
- Templates may auto-prefix `@ExpertName` when an instance exists for that pack.

Right panel Status still shows conversation `task.engagement` / `task.role` when set.

WS mention order: **expert_id / @Expert name** → explicit node_id (legacy) → @Node name (legacy/fallback).

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
