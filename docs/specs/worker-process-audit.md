# Worker process audit — collaboration dialog Spec

**Status:** ready for implementation  
**Tracker Spec (to-spec / `ready-for-agent`):** [#308](https://github.com/zangjiaao/my-ai-pen/issues/308)  
**Wayfinder map:** [#253](https://github.com/zangjiaao/my-ai-pen/issues/253)  
**Product path:** Node4 Graph × Pi + platform conversation UI  
**Does not implement product code in this document** — normative contracts only.

**Prototype (chrome reference):** [`docs/wayfinder/prototypes/worker-audit-dialog.html`](../wayfinder/prototypes/worker-audit-dialog.html) (`?variant=C`)

**Research inputs (facts at charting / revalidation; not SoT after this Spec):**

- [Research: Subagent stream and Case persistence](https://github.com/zangjiaao/my-ai-pen/issues/254)
- [Research: Worker identity continuity](https://github.com/zangjiaao/my-ai-pen/issues/255)
- [Research: Codebase drift revalidation](https://github.com/zangjiaao/my-ai-pen/issues/306)

**Decision tickets (frozen product law):**

- [Grilling: Package-turn timeline](https://github.com/zangjiaao/my-ai-pen/issues/256)
- [Grilling: Display-name model](https://github.com/zangjiaao/my-ai-pen/issues/257)
- [Grilling: Live fidelity + Main bounds](https://github.com/zangjiaao/my-ai-pen/issues/258)
- [Prototype: dialog skeleton → prefer C](https://github.com/zangjiaao/my-ai-pen/issues/259)

**Adjacent (do not confuse with this Spec):**

- [`stream-message-identity.md`](stream-message-identity.md) — **Main** progressive list identity (`stream_id`)
- [`timeline-activity-liveness.md`](timeline-activity-liveness.md) — **Main** thinking `status` / pending chrome
- Spec #301 / #302 / harness / task-graph — Worker sort, Free bind, keep-alive/budgets (identity/scheduling only)

---

## 1. Problem

Operators can see **Worker rows** on Agent collaboration (`panel_agents`) and Tasks chips, but **cannot audit** what a Worker thought, which tools it ran, or how a Package settled. Today (gap confirmed on product tree):

| Exists | Missing |
|--------|---------|
| `subagent_started` / `subagent_finished` + `panel_agents` | Worker thinking / tool / text on the wire |
| Stable `Worker N` + id continuity / warm resume | Case-persisted multi-Package process transcript |
| Main progressive streams (#276) | Agent-scoped frames + Worker dialog |
| Policy A: package tools silenced from Case chat | A **Worker-scoped** channel for those tools |

**Goal:** Worker process is **auditable** — live and after Case reload — without dumping Worker process into Main chat.

---

## 2. Product solution (one-screen)

1. User clicks a **Worker** row on the right-panel **Agent collaboration** tree (Graph packages **and** free/`subagent` path).
2. A **modal dialog** opens with **master–detail** chrome (**prototype C**):
   - **Header:** display name + status + **Rename** + Close  
   - **Left:** Package turn list (ordinal · status · `this_turn_goal`)  
   - **Right:** selected turn = **Package card** → **process** (thinking / tool_call / text) → **Delivery**
3. **V1 interaction:** read-only audit **plus rename**. No user→Worker messages, no in-dialog abort/steer.
4. **Main chat** stays Main narrative; Worker process detail is **dialog-only**.

---

## 3. Domain terms (map language)

| Term | Meaning here |
|------|----------------|
| **Worker** | Collaboration-tree child agent (subagent); stable `agent_id` (`sub_*`); default label `Worker N` |
| **Package turn** | One Main→Worker package attempt on that Worker thread (handoff + process + delivery) |
| **Worker thread** | One tree node / one `agent_id`; multiple Package turns stack over time (warm resume keeps id) |
| **Delivery** | Host-facing settlement/outcome for that package attempt (not free-text inference) |
| **Display name** | Case-persistent presentation override; does not change `agent_id` |

---

## 4. UX contract

### 4.1 Open / close

| Rule | Detail |
|------|--------|
| Open | Click Worker row (not expand-only). Main row does not open this dialog. |
| Shell | **Modal** host; interior is **master–detail** (not primary right-drawer; not endless single-column scroll as primary nav). |
| Default selection | **Latest** Package turn (including **running**). |
| Close | Explicit close control; Esc optional. Closing does **not** stop the Worker. |
| Empty tree Worker | If row exists but no turns: open with honest empty (“尚无派工记录”). |
| No process frames | If Package/Delivery metadata exists but process missing (legacy Cases): open allowed; process pane honest empty — **never fabricate** thinking/tools. |

### 4.2 Master–detail body

**Left list (per turn):** `Package {n}` · status (`running` / `ok` / `failed` / `interrupted`) · title = `this_turn_goal` (clipped).

**Right pane (selected turn only):**

1. **Package card** (dispatch / system-like, not Worker speech)  
   - Default visible: **`this_turn_goal`** (title), **`target`**  
   - Secondary/collapsed: `scope`, `already_done`, `success_criteria`  
   - Expandable: full handoff text + optional `assignment`  
   - Field **names** must match host handoff keys (`node4` `HANDOFF_FIELD_KEYS`) — do not invent aliases in UI copy as SoT.
2. **Process stream** (chronological, interleaved):  
   - `thinking`  
   - `tool_call` (start → end/output; Main-like tool card semantics)  
   - `text`  
   - **Not V1:** confirm/vuln cards, nested subagent tree, usage dashboard  
   - **Not:** parent Main `subagent` tool card copied in as Worker process
3. **Delivery card** when attempt terminates:  
   - **ok:** summary + optional collapsible structured settlement  
   - **failed:** error/reason  
   - **interrupted:** distinct from failed (product: interrupt ≠ package-fail)  
   - **running:** no Delivery card; process may still stream  

### 4.3 Multi-Package thread

- Same dialog / same Worker for later Packages (list gains Package 2…n).  
- Content model remains sequential turns; chrome navigates by **list selection**.  
- V1: no multi-tab “attempts only” filter product.

### 4.4 Main vs dialog

| Surface | Allowed | Forbidden |
|---------|---------|-----------|
| **Main chat** | Main thinking/tools/text; Main’s **`subagent` tool_call** at Main narrative grain (goal line, ok/fail); optional **one-line** lifecycle (“dispatched/finished Worker…”) | Worker thinking; step tool stdout; process text; full Worker timeline mirror; hardcoded fake progress (AGENTS.md) |
| **Right panel tree** | status / `current_detail` / count | substitute for process audit |
| **Worker dialog** | Package + process + Delivery for that `agent_id` | User messages to Worker; steer/abort-one-worker (V1) |

---

## 5. Display-name contract

| Rule | Detail |
|------|--------|
| Key | Case-global stable **`agent_id`** (subagent id) |
| Storage | **Platform Case** participants / panel metadata — **platform owns writes** |
| Not SoT | Browser-only storage; Node `taskDir`; rewriting Package handoff text |
| Resolve (single rule) | `user_display_name(agent_id) ?? panel_agents.name ?? "Worker N"` |
| Write API | Case-scoped write (REST or WS equivalent): conversation/case id + `agent_id` + `display_name` |
| Clear | Empty string clears override → fallback |
| Validation | Trim; length ~1–64; no control chars; uniqueness **not** required; last-write-wins |
| While running | **Allowed** (presentation only; no session/handoff change) |
| Propagate near-real-time | Collaboration tree title · dialog header · Tasks chip / `owner_agent_name` **presentation** |
| Ordinal | System `Worker N` stays bound to first-seen `agent_id` (resume stable); rename does **not** renumber |
| Who may rename | Any operator who can use that Case collaboration UI; any Worker on the tree |
| Out of model | Main / non-subagent participant rows |

---

## 6. Data & wire contract (implementation must design to this)

Today’s gap is intentional Policy A + no package-session observability attach. Implementation **must add** a Worker audit path without violating Main-vs-dialog.

### 6.1 Identity on every Worker frame

Every Case-visible Worker audit event/frame **MUST** carry:

| Field | Role |
|-------|------|
| `agent_id` | Stable subagent id (same as `panel_agents[].id` / Tasks `agent_id`) |
| `package_turn_id` | Stable id for one Package attempt on that Worker (new per dispatch/resume package) |
| `stream_id` | Progressive identity for thinking/text (extend Main #276 model **inside** Worker scope) |
| Conversation / task ids | Existing Case correlation fields |

Optional but recommended: `worker_ordinal` (N) for debug; display still uses display-name resolve rule.

### 6.2 Event classes (logical)

| Class | When | Payload (normative intent) |
|-------|------|----------------------------|
| **Package start** | Host admits/starts a package for Worker | handoff five fields + optional assignment; `package_turn_id`; `agent_id` |
| **Process progressive** | Child session thinking/text | same progressive semantics as Main; **scoped** by `agent_id` + `package_turn_id` |
| **Process tool** | Child tool start/end/output | tool name, status, output excerpt; **Worker channel only** |
| **Package delivery** | Host settles attempt | `ok` \| `failed` \| `interrupted` + summary + optional structured settlement |
| **Lifecycle** (existing) | `subagent_started` / `subagent_finished` + `panel_agents` | may remain; **not** sufficient alone for process audit |

### 6.3 Channel split (fail-closed)

| Channel | Contains | Main chat render? |
|---------|----------|-------------------|
| **Main narrative** | Main agent streams; Main depth-0 tools including `subagent` tool card | Yes |
| **Worker audit** | Package start/delivery + Worker process frames | **No** — only Worker dialog (and any future non-Main audit views) |

**Policy A evolution:** package sessions must **not** inject Worker process into Main chat. Implementation may either:

- keep silencing Main-bound `tool_output` **and** emit parallel Worker-scoped frames, or  
- re-route child tools exclusively to the Worker channel,

but **must not** double-render process in Main and dialog.

### 6.4 Node4 attach (normative outcome)

Package LLM sessions (**Graph and free**) that today call `createBoundNode4Session` without observability **must** produce Worker audit process frames for thinking/text/tools. Concrete attach site is an implementation choice (`attachNode4SessionObservability` variant, dedicated Worker stream bridge, etc.) **provided** §6.1–§6.3 hold.

### 6.5 Persistence & Case replay

| Rule | Detail |
|------|--------|
| SoT for dialog rebuild | **Case-persisted** messages + participants/panel + display_name overrides |
| Not SoT | Live Node process; idle pool; `taskDir/subagents/` disk |
| Record when dialog closed | **Yes** — frames persist even if no client has the dialog open |
| Reload / re-enter Case | Dialog reconstructs from Case only (no Node required) |
| Pre-Spec Cases | Honest empty process; no fabrication |
| Storage shape | Prefer `content` JSONB fields (`agent_id`, `package_turn_id`, …) and/or typed `msg_type`s; SQL agent column optional |

Suggested `msg_type` set (names illustrative; implementers may merge into existing types with required content keys):

- `worker_package_start`  
- `worker_package_delivery`  
- progressive `thinking` / `text` / `tool_call` **with** Worker scope keys (filtered out of Main list)

### 6.6 Live open mid-run

1. Load historical prefix for `agent_id` (all Package turns).  
2. Subscribe to live Worker-channel frames for that `agent_id`.  
3. Brief catch-up gap OK; timeline continuous after catch-up.  
4. Progressive fidelity: thinking/text progressive under `stream_id` (token or small chunks; short buffer OK); tools at least start→end/output. **Status-only “running” is not enough.**

### 6.7 Query / FE filter

| Consumer | Filter |
|----------|--------|
| Main message list / live overlay | Exclude Worker-scoped process frames (by `agent_id` present on Worker channel **or** explicit scope flag) |
| Worker dialog | Include only frames for selected `agent_id`; right pane further filters by selected `package_turn_id` |
| Collaboration tree | Continues to use `panel_agents` (unchanged role) |

Reuse Main progressive identity ideas (`stream_id`, #276) **inside** the dialog; do not force Worker frames into Main list identity.

---

## 7. Seams (test here)

| Seam | Behavior |
|------|----------|
| **S1 Display resolve** | pure: override ?? panel name ?? Worker N; clear override |
| **S2 Channel filter** | Main list never shows Worker process; dialog shows only matching `agent_id` |
| **S3 Turn model** | package start → process events → delivery; running has no delivery |
| **S4 Interrupt vs fail** | delivery status mapping distinct |
| **S5 Late open** | history prefix + live append without dropping prefix |
| **S6 Case replay** | rebuild from persisted fixtures without Node |
| **S7 Rename propagate** | tree / dialog header / Tasks presentation share string after write |
| **S8 Handoff fields** | Package card keys ⊆ `target, scope, already_done, this_turn_goal, success_criteria` (+ assignment) |

Prefer pure unit tests for S1–S4; integration/smoke for S5–S7.

---

## 8. Acceptance criteria / DoD

Implementation is done when **all** hold:

1. **Open path:** Clicking any collaboration-tree Worker opens the audit modal (Graph and free Workers).  
2. **Chrome:** Master–detail; default latest turn; rename control present.  
3. **Package card:** Handoff five fields; goal/title primary.  
4. **Process:** Live progressive thinking/text + tool boundaries for **new** packages after ship; Main-like cards.  
5. **Delivery:** Host-sourced ok/failed/interrupted; no Delivery while running.  
6. **Multi-Package:** Second package on same `agent_id` appears as new list row in the **same** dialog.  
7. **Main clean:** Worker process not in Main chat; Main may keep `subagent` tool card + optional one-line lifecycle.  
8. **Closed-dialog record:** Process frames Case-persisted without dialog open.  
9. **Case reload:** After refresh, dialog shows same Package/process/Delivery for recorded work without Node.  
10. **Rename:** Case-persistent; tree + dialog + Tasks chip update near-real-time; id unchanged; running rename OK.  
11. **Honesty:** Legacy/missing process → empty state, not fake tools/thinking.  
12. **Tests:** S1–S4 pure coverage; at least one integration path for S5 or S6.  
13. **Docs:** This Spec stays living; harness/task-graph may cross-link Worker channel without redefining Product seats.

---

## 9. Out of scope (V1)

- Implementing nested subagent recursion UI inside a Worker dialog  
- Full Main message-type parity in dialog (confirm/vuln cards, etc.)  
- User→Worker chat / in-dialog steer / abort-single-Worker  
- Cross-Case global alias library; auto-name from Package goal as requirement  
- Cross-Case export/share product  
- Using `taskDir` as Case replay SoT  
- Replacing Main #276 / #305 contracts (they remain Main-only unless explicitly extended)

---

## 10. Frozen decisions (do not re-open without Spec amendment)

1. Destination = Worker process audit via collaboration dialog (not Main dump).  
2. Live + Case replay.  
3. All tree Workers (Graph + free).  
4. Content = Package + thinking + tool_call + text; Delivery host-sourced.  
5. Worker = continuous thread (multi-Package same id).  
6. Chrome = **master–detail C**; modal host; default latest turn.  
7. Display name = Case override by `agent_id`; platform write; unified tree/dialog/Tasks.  
8. Live fidelity = Main-parity progressive Worker channel; record even if dialog closed.  
9. Main = narrative + light lifecycle only.  
10. V1 = read-only + rename.

---

## 11. Suggested implementation waves (non-normative ordering)

| Wave | Deliverable |
|------|-------------|
| **W1 Wire** | Worker-scoped emit + Case persist + channel filter (Main stays clean) |
| **W2 Dialog** | Modal master–detail UI bound to Case history + live |
| **W3 Rename** | Case display_name API + presentation resolve everywhere |
| **W4 Hardening** | Interrupt delivery typing; late-open catch-up; legacy empty honesty; tests S1–S8 |

Waves may merge; DoD is §8, not wave labels.

---

## 12. Map / issue index

| Artifact | Link |
|----------|------|
| Wayfinder map | [#253](https://github.com/zangjiaao/my-ai-pen/issues/253) |
| Spec task | [#260](https://github.com/zangjiaao/my-ai-pen/issues/260) |
| Prototype HTML | [`docs/wayfinder/prototypes/worker-audit-dialog.html`](../wayfinder/prototypes/worker-audit-dialog.html) |
