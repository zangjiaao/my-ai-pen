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
3. **对话** — `@ExpertName` (+ optional Goal mode). System routes to bound Node and sets `engagement` from the Expert’s pack.

## Dispatch gate

Before `task_assign` is sent to a worker, the platform checks that the engagement resolves to a pack id in the node’s effective offers. If not, dispatch fails with a clear error (install the pack on the node first).

`@Expert` resolution also requires:

- Expert exists and `enabled`
- Bound node still has that pack in offers (create/update API enforces this)

Aliases fold to canonical pack ids (same idea as Node4 `resolveRolePack`):

| engagement / role | pack id   |
|-------------------|-----------|
| pentest, assess, verify, retest | pentest |
| ctf, ctf-web, challenge | ctf |
| consult | consult |

Blank engagement defaults to **pentest** (must still be offered).

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

- **`@Expert`** (primary) — mention picker lists product experts (+ platform agent). Selecting an expert injects `agent_node_id` + structured `engagement`/`role` from the instance.
- **Goal mode** — optional long-task switch (+ objective). Independent of expert routing.
- No separate “Expert role” pack picker on the chat composer (role comes from the Expert).
- Templates may auto-prefix `@ExpertName` when an instance exists for that pack.

Right panel Status still shows conversation `task.engagement` / `task.role` when set.

WS mention order: explicit `agent_node_id` → **@Expert name** → @Node name (legacy/fallback).

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
