# Research: destructive action control — already decided or implemented

> Ticket: GitHub **#169** · Map **#166** (operator autonomy + surface-expand authorization)  
> Primary sources only · **No product code** in this resolution  
> Date: 2026-07-27

## Question

What is already **locked** or **implemented** for **destructive** actions — map #166 charting anchor ③ (**always gated even in `auto`**)?

Primary sources examined:

- Spec [#139](https://github.com/zangjiaao/my-ai-pen/issues/139) Normative Contract **NC-RoE-Destructive**
- Closed maps [#140](https://github.com/zangjiaao/my-ai-pen/issues/140) / [#145](https://github.com/zangjiaao/my-ai-pen/issues/145) and grilling [#149](https://github.com/zangjiaao/my-ai-pen/issues/149)
- Map [#166](https://github.com/zangjiaao/my-ai-pen/issues/166) charting locks **C1** / **D1**
- `allow_postex`, `<rules-of-engagement>`, `experts/pentest/work.md`
- Tool-level gates / confirm paths for reset-delete-class ops
- Living specs: `docs/specs/task-graph.md`, `docs/specs/harness.md`, `docs/specs/expert-offers.md`, `vision.json`
- Node4 / platform wire (`engagement-roe`, shell host gate, task envelope)

---

## Executive answer

| Layer | Status | Gist |
|-------|--------|------|
| **Product law (classes + default deny + skipped_roe + lab flag)** | **Locked** (#149 → #139 **NC-RoE-Destructive**) | Independent of operator autonomy |
| **Map #166 charting** | **Locked** (C1 anchor ③ + D1) | Destructive **always** controlled; `auto` is YOLO-like for *other* classes only |
| **Host enforcement (shell)** | **Implemented** on Spec #139 tree (`feat/139-pentest-expert-process` lineage); **not on `main` as of this note** | Keyword classify → deny unless `allowDestructive` |
| **Envelope / pass-through** | **Implemented** (same tree) | Structured `allow_destructive` / `allowDestructive` only — **no free-text invent** |
| **RoE prompt injection** | **Implemented** (same tree) | `<rules-of-engagement>` includes `allow_destructive` + deny steer |
| **`operator_autonomy` (`guided` \| `auto`)** | **Not implemented** | Map #166 grilling (#173 etc.) still open |
| **http / session / browser host gate** | **Not implemented** for NC-RoE classes | Only `shell` calls `assertDestructiveAllowed` today |
| **Vision Risk Tier 4-level matrix** | **Aspirational** (`vision.json`) | Not the same object as NC-RoE-Destructive / not wired to autonomy |

**What `auto` must still never free (already product law + charting):**

1. **Default-deny destructive classes** unless **explicit structured** engagement/RoE `allow_destructive` / `allowDestructive` is true (lab/customer override — never product default, never free-text invent).
2. **Execution of those classes when denied** — agent must not perform wipe/flood/bulk-delete/etc.; record **`skipped_roe`**; may book *entry/capability* only with **non-destructive** observation + normal proof bar.
3. **Customer product default** — lab may set allow; must **not** flip customer default to allow (#149 / NC-RoE Lab row).
4. **Post-ex / lateral** remains a **separate** flag (`allow_postex`) — not lifted by `auto` or by destructive allow alone.

**What remains undecided for map #166 (not re-litigating #149 classes):**

- How destructive sits in the **authorization-class registry** shape (#170) and **fail-closed enforcement locus** (#174) next to asset/scope + surface-include anchors.
- Whether `auto` suppresses **agent-initiated** `request_user_decision` for “destructive *proposal*” while host deny still holds, or whether proposal cards remain required when the agent wants to *ask* for allow.
- Non-shell act paths (HTTP form posts that wipe without matching shell keywords); classifier completeness; parity across tools.
- Lab UX: when/how `allow_destructive=true` is set on the envelope without shipping customer-default allow.
- Interaction of `auto` with **`allow_postex`** / `redteam_deep` (orthogonal but operator-confusing).

---

## 1. Locked decisions (GitHub product law)

### 1.1 Grilling #149 → Spec #139 NC-RoE-Destructive

**Source ticket:** [Grilling: destructive RoE action classes and gate](https://github.com/zangjiaao/my-ai-pen/issues/149) (closed; map [#145](https://github.com/zangjiaao/my-ai-pen/issues/145)).

Resolution comment (gist, owner):

1. **Default deny** unless engagement/RoE **explicitly allows** destructive tests.
2. **Classes needing allow:** DB wipe/reset/schema create; bulk delete/overwrite; DoS/flood; state-changing password/privilege attacks. **Not** default-destructive: low-impact reads; ordinary read SQLi (still Scope-bound).
3. **When denied:** do not execute; record **`skipped_roe`** on surface/fact; may still book that an unauth destructive *entry* exists if proven with **non-destructive** observation (e.g. form reachable) without performing wipe.
4. **Lab allow:** engagement/RoE flag or lab profile — **must not** change customer product default to allow.
5. **When allowed:** still need proof bar / L0 to book impact.

Folded into Spec [#139](https://github.com/zangjiaao/my-ai-pen/issues/139) section **NC-RoE-Destructive** (same table). Map #145 destination comment lists Destructive RoE among completed normative contracts.

### 1.2 Spec #139 surrounding commitments (not reopened)

From #139 body (problem, user stories, requirements):

| Item | Text gist |
|------|-----------|
| Problem | Destructive actions without explicit RoE framing (e.g. unauthenticated DB reset) |
| US 5–6 | RoE (scope, bans, post-ex, **destructive testing**) visible and enforced; lab vs production policy without per-target forks |
| US 53 | Real-scope default **refuse destructive** unless RoE allows — lab-friendly DVWA behavior must not leak to customers |
| Req 28 | Destructive RoE: explicit allow/deny; default deny; `skipped_roe` on surfaces when denied |

Map [#140](https://github.com/zangjiaao/my-ai-pen/issues/140) closed after transferring process/discovery decisions into #139; it did **not** invent a second destructive design — #145 / #149 filled the NC.

### 1.3 Map #166 charting locks (autonomy context)

Map [#166](https://github.com/zangjiaao/my-ai-pen/issues/166) **Notes** (charting locks — do not re-open without rewriting Destination):

| Lock | Text |
|------|------|
| **C1** | Framework + three anchors: (1) asset/scope mutation, (2) surface-expand ledger include, **(3) destructive always-gated**; other sensitive tests = extension principle only this map |
| **D1** | Default **`guided`**; **`auto`** is explicit YOLO-like opt-in (**destructive still always controlled**) |
| Related | “Spec #139 destructive RoE threads”, `card-confirm` UI pattern |

So for this research ticket: **anchor ③ is already decided at chart time** — research job is inventory of *how*, not whether.

### 1.4 HITL tiers (living harness) — proposal path, not host class table

`docs/specs/harness.md` § HITL tiers:

| Tier | Expectation |
|------|-------------|
| **Act in scope** | `shell` / `http` / `session` / `browser` against authorized target — proceed under task RoE; **no card per probe** |
| **High-risk / handoff** | handoff, multi-agent transfer, **destructive/out-of-scope proposal** — **one** `request_user_decision` card; wait Authorize/Cancel |

This is **agent-initiated card** semantics for proposals/handoff, orthogonal to **host default-deny** on classified commands. It does **not** say “auto may free destructive.”

### 1.5 Vision Risk Tier (aspirational)

`vision.json` controls:

- **Risk Tier:** observe / safe / intrusive / **destructive** with different control strategies  
- **Approval Gate:** high-risk (intrusive/destructive) → ApprovalRequest card  

Treat as **product vision**, not a substitute for NC-RoE-Destructive class table. Map #166 is explicitly **not** inventing a new “Agent Harness” noun (N2) — Runtime/platform policy only.

---

## 2. Orthogonal control: `allow_postex` (not destructive)

| Concern | Field | Product default | Template lift |
|---------|-------|-----------------|---------------|
| Post-ex / lateral / host control | `allow_postex` / `allowPostex` | **false** | `redteam_deep` → true (`docs/specs/expert-offers.md`, `case_engagement` / Node `resolveEngagementRoe`) |
| Destructive wipe/flood/… | `allow_destructive` / `allowDestructive` | **false** | **Never** template-implied; lab/explicit only (NC-RoE) |

`experts/pentest/work.md` still says honor `<rules-of-engagement>` (`allow_postex`, bans/focus) — RoE injection on the Spec #139 tree also carries **`allow_destructive`**. Pack graph `roe.allow_postex` gates post-ex **node types** (e.g. subagent `requires_postex`), not NC-RoE destructive classes.

**Implication for `auto`:** flipping autonomy must not silently imply either flag.

---

## 3. Implemented machinery (Spec #139 tree; inventory)

> **Branch note:** As of this research, destructive host gate + envelope fields live on the Spec #139 implementation lineage (local `feat/139-pentest-expert-process` / equivalent). **`main` still has RoE with `allowPostex` only** and shell without `assertDestructiveAllowed`. Living doc row on that tree: `docs/specs/task-graph.md` → **Destructive RoE**.

### 3.1 Class list + gate (`node4/src/runtime/engagement-roe.ts`)

```text
DESTRUCTIVE_ACTION_CLASSES =
  db_wipe_reset
  | bulk_delete_overwrite
  | dos_flood
  | password_state_change
  | privilege_elevation_attack
```

- `classifyDestructiveAction(description)` — **conservative keyword** patterns on the act description/command string (not target-name detection).
- `assertDestructiveAllowed(roe, description)` — if classified and `!roe.allowDestructive` → `{ ok: false, error: … skipped_roe … }` (default deny).
- `resolveEngagementRoe({ allowDestructive? })` — non-boolean → **`false`**.
- `formatRoeInjection` — emits:

```text
<rules-of-engagement>
…
allow_postex: …
allow_destructive: true|false
…
Forbidden … Destructive tests … unless allow_destructive=true   (when denied)
Destructive tests are DENIED by default. … record … skipped_roe …
</rules-of-engagement>
```

Tests: `node4/src/runtime/engagement-roe.test.ts` (default deny; setup.php/DB wipe classified; lab allow path).

### 3.2 Shell host gate (`node4/src/tools/shell.ts`)

Before execute:

1. `resolveEngagementRoe({ engagementTemplate, engagement, allowPostex, allowDestructive })` from `runtime.task`
2. `assertDestructiveAllowed(roe, command)`
3. On fail → tool error text; **no process spawn**

**Only `shell` is gated this way.** `http` / `session` / `browser` do not call `assertDestructiveAllowed` in current tree.

### 3.3 Structured envelope only (no NLP invent)

`node4/src/runtime/task-envelope-fields.ts` — `parseAllowDestructive(message)`:

- Accepts `allow_destructive` | `allowDestructive` as optional wire boolean  
- **Undefined when absent** → resolve path default **deny**  
- Tests explicitly: free-text `"please allow destructive tests"` does **not** set the flag (`task-envelope-fields.test.ts`, `f1-envelope.test.ts`)

Platform pass-through: `platform/backend/app/ws/router.py` copies structured `allow_destructive` / `allowDestructive` onto `task_assign` when present (bool or true/false strings).

### 3.4 Product-state `skipped_roe` channel (pre-existing + RoE steer)

Surface ledger (`node4/src/stores/surface-ledger.ts`, `docs/specs/task-graph.md`):

- Status enum includes **`skipped_roe`**
- Graph `todo(done)` honesty path accepts `note=skipped_roe` when open surfaces remain

RoE / shell deny steers the agent to record this; the host gate itself returns a **tool error** and does not auto-write ledger status.

### 3.5 Agent confirm / HITL tool

`request_user_decision` (`node4/src/tools/decision.ts`) — optional `risk_level` (default `intrusive`); used for handoff / confirm cards. **Not** automatically invoked when shell destructive gate fires. Harness high-risk tier expects the **agent** to raise a card for destructive *proposals* when appropriate.

### 3.6 Pack / skills steer (soft)

Examples (not host gates):

- `experts/pentest/work.md` — honor RoE block; proof bar; no unbounded brute  
- Skills: prefer non-destructive proof first (`pentest-ssti`, `pentest-ssrf` avoid destructive cloud actions; `pentest-lateral` / file-upload / cache bans)  
- `experts/consult/work.md` — avoid destructive actions  

### 3.7 Living spec summary row

`docs/specs/task-graph.md` (Spec #139 tree):

> **Destructive RoE** — Default deny destructive classes … unless engagement `allowDestructive`. **Host gate:** shell tool rejects classified destructive commands when deny; RoE injection still steers agents. Lab may set `allowDestructive` on the task envelope (NC-RoE-Destructive).

---

## 4. What `auto` must still never free (map #166 answer)

From **C1 + D1 + NC-RoE-Destructive** (already decided):

| Must remain controlled under `auto` | Mechanism already locked / present |
|-------------------------------------|------------------------------------|
| NC-RoE **class list** acts when `allowDestructive` is false/unset | Default deny law; shell host gate (on #139 tree); RoE injection |
| **Inventing** allow from chat/instructions | Envelope parse is structured-only (tests forbid free-text invent) |
| Customer **default** allow | Lab flag only; NC Lab row |
| Silent execute + no Product state | Denied path: no execute + **`skipped_roe`** / non-destructive booking only |
| Booking impact without proof just because auto | “When allowed: still proof bar / L0” (#149) |
| Post-ex / lateral | Separate `allow_postex`; templates only for that flag |

`auto` (when designed) may free **guided** friction for *other* authorization classes (e.g. surface-include ledger write under G1, subject to grilling). It does **not** become a second path to `allow_destructive=true`.

---

## 5. Gaps / undecided (for map #166, not re-open #149)

| Gap | Why it matters |
|-----|----------------|
| **`operator_autonomy` not in code** | #173 placement/UX still open; no wire today |
| **Registry + enforcement locus** | #170 / #174 — how anchor ③ is *named* beside asset/scope and surface-include |
| **Proposal HITL vs host deny under `auto`** | Harness high-risk card is agent-driven; no product rule yet that auto skips or keeps “please allow destructive” cards |
| **Non-shell act surfaces** | HTTP/session can perform wipe-class ops without matching shell keywords |
| **Classifier brittleness** | Keyword list is intentional steer/gate, not a complete security boundary; evasion / non-English / indirect scripts |
| **Lab product path** | How UI/config sets `allow_destructive` for DVWA-class without shipping default true |
| **work.md one-liner** | Still emphasizes `allow_postex`; destructive is in injected RoE but less visible in pack work text |
| **main vs #139 land** | Until #139 ships, `main` has **decision lock only** + post-ex RoE — **no** destructive host gate |

Out of scope for this research (per map #166): implementing Runtime/UI; full C2 catalog of every sensitive pentest action.

---

## 6. Citations index

| Source | Role |
|--------|------|
| [#149](https://github.com/zangjiaao/my-ai-pen/issues/149) resolution | Action classes + default deny + skipped_roe + lab |
| [#139](https://github.com/zangjiaao/my-ai-pen/issues/139) **NC-RoE-Destructive** | Build-authority fold of #149 |
| [#145](https://github.com/zangjiaao/my-ai-pen/issues/145) close | Normative contracts complete for #139 |
| [#140](https://github.com/zangjiaao/my-ai-pen/issues/140) close | Process/discovery decisions → #139 (not a second destructive design) |
| [#166](https://github.com/zangjiaao/my-ai-pen/issues/166) Notes | C1 anchor ③; D1 auto still controls destructive |
| `docs/specs/task-graph.md` | Living Destructive RoE + surface `skipped_roe` |
| `docs/specs/harness.md` | HITL high-risk / act-in-scope tiers |
| `docs/specs/expert-offers.md` | Template → `allow_postex` only |
| `vision.json` | Aspirational Risk Tier / Approval Gate |
| `node4/src/runtime/engagement-roe.ts` | Classes, classify, assert, inject |
| `node4/src/tools/shell.ts` | Host gate call site |
| `node4/src/runtime/task-envelope-fields.ts` | Structured parse; no NLP |
| `platform/backend/app/ws/router.py` | `allow_destructive` pass-through |
| `experts/pentest/work.md` | Honor RoE; process quality |
| `node4/src/stores/surface-ledger.ts` | `skipped_roe` status |

---

## 7. Resolution for #169

**Already locked:** NC-RoE-Destructive (#149/#139) + map #166 C1③/D1 — destructive is default-deny, class-listed, lab-overridable only via structured flag, always controlled even if `operator_autonomy=auto`.

**Already implemented (Spec #139 tree):** RoE injection, structured envelope, shell host keyword gate, tests, living task-graph row; surface `skipped_roe` channel exists.

**Not implemented / still open for this map:** `operator_autonomy` field and UX; registry placement of the destructive class next to other anchors; non-shell parity; proposal-card policy under auto; lab UI for allow; landing host gate on `main`.

No feature code in this ticket. Further map work should **consume** NC-RoE-Destructive, not redesign classes, unless a conflict forces Destination rewrite.
