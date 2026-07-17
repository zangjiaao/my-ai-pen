# Plan: Remove platform conversation Agent → Node built-in `default`

> **Status:** approved direction (product) — **not yet implemented**  
> **Date:** 2026-07-17  
> **Precedence:** `AGENTS.md` → `prd.md` → this plan → `node-expert-offers.md` / `node4-harness.md`  
> **Runtime:** `node4/` only. Platform remains ledger + relay + UI — **no peer conversation Agent**.

When this plan is executed end-to-end, update living docs in the **same change** and mark this plan **done** (or fold remaining open items into PRD/offers/harness and archive the rest).

---

## 1. Goal

Stop running a **platform-side conversation Agent** (orchestrator chat, `platform_chat`, `snapshot_qa`, hard-coded expert preamble, fake dual-identity room).  

All user-facing intelligence lives on **Node4**:

| Participant | Where | Role |
|-------------|--------|------|
| **`default`** | Built into every Node (not a commercial expert pack) | General assistant: chat, read/organize platform ledger via **platform data tools**, light asset enrich + finding status maintenance |
| **Experts** (`pentest`, `ctf`, …) | Installable packs + product Expert instances | Execution work bursts (OMP harness, booking when applicable) |
| **Platform** | Backend + UI | Auth, conversations, messages, assets, vulns, evidence, node/offers, WS relay, authorization cards — **does not speak as an Agent** |

**Why:** Shared-room routing across backend LLM vs Node caused wrong speaker, sticky expert mis-attribution, and experts that could not see platform ledger data. Single path: **UI participant → Node seat**.

---

## 2. Non-goals

- Remote marketplace / hot-load of packs.
- NLP of free-text to pick expert/workflow (`AGENTS.md`).
- Letting **any** agent create new **host** asset rows (still **user-only**).
- Replacing the asset/vuln **pages** with chat-only management (pages stay; default helps via tools).
- Multi-Node mesh or Node↔Node direct collab.

---

## 3. Product model

```text
User ── conversation ──▶ Platform (ledger / WS / UI)
                              │
                              │  always forward to selected Node participant
                              ▼
                         Node4 Runtime
                         ├─ default   (always-on built-in seat)
                         │    platform.* data tools + light assist tools
                         └─ expert packs (pentest / ctf / …)
                              full act + booking when pack allows
```

### 3.1 `default` (built-in seat)

- **Product name (UI):** 工作台助手 (English: Workspace assistant).  
- **Technical id:** `default` (alias: `consult` for pack/catalog continuity during migration).  
- **Not** listed as a user-created Expert in 专家管理 (system seat, not uninstallable commercial pack).  
- **Ships with Node install** — no empty “bare runtime only” as the product default participant.  
- **Mission:** help the user manage and understand **platform data** and session context; prepare for handoff to an expert when execution is needed.  
- **Does not** run penetration / CTF exploit work bursts; does not book product findings (`bookingMode=none`).  
- May **suggest** switching to a named expert; does not invent engagement via NLP.

### 3.2 Experts

- Unchanged three-layer model: catalog pack → node offers → product Expert instance (`@name` → node + pack).  
- User switches partner in composer: **工作台助手** vs **@渗透大师** etc.  
- Expert dispatch still carries structured `engagement` / `expert_id` / target / RoE / optional goal.

### 3.3 Platform

- **No** platform Agent node (`PLATFORM_AGENT_NODE_ID`) as a chat peer.  
- **No** LLM orchestrator deciding who answers user chat.  
- Thin rules only (structured fields), e.g.:
  - selected participant + message → assign/steer that Node;
  - missing online Node → honest error to UI (not a platform monologue Agent).

---

## 4. Routing (after refactor)

```text
Composer participant = default | Expert instance
  → WS user_message carries agent_node_id + engagement/expert_* (structured)
  → Platform: persist user message, authz, optional thin gate
  → Always Node: task_assign | user_steer
  → Node: resolve pack (default seat vs installed expert)
  → Events back on same conversation (attribution = participant, never sticky-wrong)
```

| Before | After |
|--------|--------|
| No @ → platform Agent | No expert selected → **default** on chosen/sticky Node |
| @Expert → Node | @Expert / toolbar Expert → Node (unchanged) |
| Backend planner `ask_clarification` / `platform_reply` | Removed for chat; Node default answers with tools |
| Expert selected, no target → platform-forged or expert_room_chat on backend | Node **default or expert chat-only** path on Node (model-authored; no canned monologue) |

**Attribution rule:** Agent messages use the **active participant only**. Do not stamp sticky expert_name onto default/platform system rows.

---

## 5. Platform data tools (Node → Platform)

Exposed to Node as first-class tools (names illustrative; implement with stable JSON schema + audit).

| Tool | `default` | Execution packs |
|------|-----------|-----------------|
| `platform.list_assets` / `get_asset` | ✓ | optional (prefer case scope) |
| `platform.list_vulnerabilities` / `get_vulnerability` | ✓ | optional |
| `platform.update_finding_status` | ✓ | optional |
| `platform.enrich_asset` (ports/services/URLs/APIs; **no host create**) | ✓ | ✓ (existing policy) |
| `platform.conversation_snapshot` (progress, counts, recent findings) | ✓ | ✓ |
| Suggest handoff (chat only; or structured UI hint later) | ✓ | — |

**Policy (unchanged product rules):**

- Host rows: **user-only create**.  
- Mutations: audit_log; respect conversation/user scope.  
- Auth: Node token + conversation ownership; no global unscoped dump by default.

**Transport:** Prefer existing Node↔platform channel (HTTP management API with node token, or WS request/response). Single path — do not reintroduce a backend “agent that reads DB and speaks.”

---

## 6. Node packs & lifecycle

### 6.1 `default` vs bare vs consult

| Concept | After refactor |
|---------|----------------|
| **Product default participant** | Built-in `default` seat (always available when Node online) |
| **`consult` catalog pack** | Fold into / alias of `default` (mission upgraded for ledger tools); remove “stub-only” product narrative |
| **`runtime` bare** | Lab/A-B only (no packs); **not** the default UI participant |

### 6.2 Chat-only vs execution burst

| Mode | When | Settlement / UI |
|------|------|-----------------|
| **Chat-only** | `default`, or expert without authorized target/scope | No engagement right-panel; no incomplete-as-failure UX; harness settles completed / non-task terminal |
| **Execution burst** | Expert + structured target (and pack allows act/book) | Full OMP loop; right panel when real work products / target |

Right panel stays gated on **real target or work products**, not “any agent message.”

### 6.3 Tool surface (`default`)

- Platform data tools (required).  
- Light assist: e.g. `todo`, `read` (task dir notes); **shell optional / restricted** (prefer off or read-only policy for default).  
- **No** `finding` booking tool.  
- No pentest session/browser density by default.

---

## 7. UI changes

- Composer partner list: **工作台助手 (default@Node)** + product experts.  
- Remove **平台助手** as a fake platform Agent peer.  
- Default selection: 工作台助手 when no expert chosen.  
- Multi-Node: user picks which Node’s default (or sticky last Node); document in offers/UI.  
- Message attribution: expert card only when that expert is the speaker.

---

## 8. Code removal / shrink (implementation checklist)

### 8.1 Platform backend (target end state)

- Remove or gut conversation **platform Agent** paths:
  - `agent_orchestrator` **chat** planning for user replies (thin structured dispatch only if anything remains)
  - `answer_platform_chat`, `answer_snapshot_qa`, `answer_expert_room_chat`, canned `answer_clarification` as user-visible speech
  - `_reply_expert_preamble` backend monologue path
- Stop treating `PLATFORM_AGENT_NODE_ID` as a chat participant (may remain internal sentinel only if needed for migrations — prefer delete from UI).
- User message handler: **resolve participant → forward Node**; no multi-mode LLM router.
- Message save: **do not** attach sticky expert identity onto non-expert speakers.

### 8.2 Platform frontend

- Partner model: default seat + experts (no platform Agent kind).  
- Send path always sets Node participant fields.  
- Keep: no optimistic `running` without real target; right panel gates.

### 8.3 Node4

- Built-in resolve: blank / `default` / `consult` → default seat pack.  
- Implement platform data tools + auth.  
- Chat-only settlement for default (and no-target expert if retained on Node).  
- Catalog/docs: `consult` → default narrative.

### 8.4 Docs (same change as code)

- `prd.md`, `node-expert-offers.md`, `node4-harness.md`, `experts/README.md`, this plan status.  
- `design.md` mentions of “平台 Agent 命名会话” → default Node or pure API title helper (no peer Agent required).

---

## 9. Phased delivery (single goal may ship all)

| Phase | Deliverable | Verify |
|-------|-------------|--------|
| **P0** | Node `default` seat + platform data tools; chat-only settle | default can list vulns/assets for a real conversation; no incomplete on “你好” |
| **P1** | UI partner = 工作台助手 + experts; drop platform Agent entry | new session default speaker is Node default |
| **P2** | Platform: strip conversation Agent / orchestrator chat; pure relay | no `agent_source=platform` chat replies; all chat from Node |
| **P3** | Docs + tests green; delete dead platform agent modules | living docs match code |

Implementation may collapse P0–P2 into one goal if scoped carefully.

---

## 10. Acceptance criteria

1. **No platform conversation Agent:** user cannot address a platform LLM peer; no forged expert monologue from backend.  
2. **Default on Node:** every online Node can run 工作台助手 without installing a commercial expert pack.  
3. **Ledger visibility:** default answers “库里有哪些漏洞/资产” via **tools reading platform DB**, not guessing.  
4. **Finding/asset maintenance:** default can update finding status and enrich existing hosts; **cannot** create hosts.  
5. **Expert switch:** selecting 渗透专家 + target still runs full pentest work burst; findings land on platform.  
6. **Identity:** UI attribution matches active participant; sticky expert does not relabel default replies.  
7. **No cross-backend chat routing:** one hop user → platform relay → Node.  
8. **AGENTS.md:** no hardcoded user-visible agent scripts; no NLP engagement invent.

---

## 11. Open decisions (defaults if implementer needs them)

| Topic | Default decision |
|-------|------------------|
| Product label | 工作台助手 / Workspace assistant |
| Technical id | `default` (`consult` alias) |
| Multi-Node default seat | Sticky last Node; else sole online Node; else error “select a node” |
| default + shell | Off or highly restricted in v1 |
| Session auto-title | Optional small platform **non-Agent** API or default Node tool later — not a chat peer |

---

## 12. Related docs

- `docs/prd.md` — product positioning (updated to point here until refactor lands)  
- `docs/node-expert-offers.md` — routing model  
- `docs/node4-harness.md` — packs / bare vs default  
- `docs/archive/multi-expert-collaboration-plan.md` — historical Case collab notes (participant model superseded by this plan’s default + experts)
- `experts/README.md` / `experts/consult/` — migrate to default seat  
