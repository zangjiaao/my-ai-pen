# Node expert offers (multi-expert container)

## Model

- A **Node** is a **container** (worker process / runtime), not one fixed expert forever.
- **Experts** are installable **role packs** (`pentest`, `ctf`, `consult`, …) listed on `node.config.offers`.
- **Default**: when `offers` is missing or empty, the effective list is **`["pentest"]` only**.
- Task assignment must carry an **explicit structured** `engagement` and/or `role` field. The platform **does not** invent engagement by scanning free-text instructions (no NLP routing).

## Dispatch gate

Before `task_assign` is sent to a worker, the platform checks that the engagement resolves to a pack id that appears in the node’s effective offers. If not, dispatch fails with a clear error (install the expert first).

Aliases fold to canonical pack ids (same idea as Node4 `resolveRolePack`):

| engagement / role | pack id   |
|-------------------|-----------|
| pentest, assess, verify, retest | pentest |
| ctf, ctf-web, challenge | ctf |
| consult | consult |

Blank engagement defaults to **pentest** (must still be offered).

## Install / uninstall API

Authenticated management endpoints (billing hooks only — **no payment provider**):

- `GET /api/nodes/{node_id}/offers` — list effective offers
- `POST /api/nodes/{node_id}/experts` body `{"expert_id":"ctf"}` — install; audit `expert.install`
- `DELETE /api/nodes/{node_id}/experts/{expert_id}` — uninstall; audit `expert.uninstall`

Billing event detail includes stable `billing_code` (e.g. `expert.ctf`), `expert_id`, and `action` (`install` | `remove`).

Node list/detail also expose `offers` on the node payload.

## Conversation UI

Conversation composer has an **Expert role** control next to Goal mode:

- Options come from the shared catalog (`lib/experts.ts`: pentest / ctf / consult).
- Available choices are filtered by the **target worker node’s** effective offers (mention → sticky conversation node → first online worker).
- Packs not installed on that node are disabled with an install hint (`Nodes → Experts`).
- Templates (Web pentest, CTF challenge, Consult, …) also switch engagement when the pack is installed.
- The choice is sent as structured `engagement` + `role` on `user_message` / task assign — independent of Goal mode and free-text.

Right panel Status tab shows the conversation’s structured expert role when `task.engagement` / `task.role` is set.

## Node management UI

- Node cards list installed expert chips.
- Node detail → **专家包** tab: install / uninstall each known pack (calls `POST/DELETE …/experts`).
- Dispatches `nodes:changed` so the conversation page refreshes offers without a full reload.

## Usage billing on complete

On `task_complete`, the platform records audit action `expert.usage` with `billing_code`, pack id, task/conversation/node ids, and status. Hooks only; no charge.

## Code map

- Pure helpers: `platform/backend/app/services/expert_offers.py`
- Node API: `platform/backend/app/api/nodes.py`
- Gate + usage: `platform/backend/app/ws/router.py`
- UI: `platform/frontend/src/pages/ConversationPage.tsx`, offers on `NodePage`
- Tests: `tests/test_expert_offers.py`
- Role resolution on worker: `node4/src/roles/` (product Node runtime)

Product node line is **Node4 only**; see `docs/prd.md`.
