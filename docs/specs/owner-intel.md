# Spec: Owner ledger Intel (线索 / 情报)

**Status:** Living — shipped (Host/Service 情报 tabs + Findings 线索 + Agent record/list/get/forget).  
**Tracker:** Map [#459](https://github.com/zangjiaao/my-ai-pen/issues/459) · draft [#472](https://github.com/zangjiaao/my-ai-pen/issues/472)  
**Decision source:** Hang + Intel≠Finding (map notes); lifecycle [#466](https://github.com/zangjiaao/my-ai-pen/issues/466); kinds [#469](https://github.com/zangjiaao/my-ai-pen/issues/469); identity [#470](https://github.com/zangjiaao/my-ai-pen/issues/470); write/read + persist cadence [#471](https://github.com/zangjiaao/my-ai-pen/issues/471).

**Product path:** Owner ledger (Group × Host × Service) + Case projection.  
**Amends:** `docs/specs/owner-ledger.md` — Intel wave was reserved (“not this wave”). This Spec **is** that wave.  
**Consumed by:** `docs/specs/context-window-management.md` (compact injects **living** intel ≤20 lines after a persist pass).

**Does not amend:** Finding identity / book-path L0 (#275); Case Surface (#368); intent NLP ban; Default seat never-Graph.

---

## Problem

Operators and later Sessions lose **operational memory** that is not a Vulnerability: default password no longer works, JWT lives in a cookie, an account enum, a path worth retrying. Finding ledger must stay proof + severity. Chat is not SOT. The field case (`6a2e9e8a-…`) continued via prior vulns after a bad password — the missing object is **asset-hung clues**.

UI already has **情报** tabs with empty honest copy. Product law for the rows was missing.

---

## Solution

**Intel** = the Agent’s **notebook** on a **Host** or **Service**: things worth remembering so the next turn / Session / compact does not forget. Not a Finding. Not a Case-owned dump. Case **projects** Scope ∩ living intel into the Findings pane (a **section**, not a new right-panel tab).

Prompt framing (pack / Runtime): this is your notebook. Write what you need to keep. Do not treat it as a chore checklist.

**Agent writes data only.** Harness stamps identity and audit. Host does **not** scrape chat or tool stdout.

### Agent-supplied (tool args)

| Field | Law |
|-------|-----|
| `summary` | Short. List / retrieve / compact inject. |
| `body` | Natural-language 情报/线索. Full text via `get(id)`. |
| `hang` | Host id, or Host+port (Service). **v1: no Group hang.** |
| `kind` | Closed v1 enum. Classification + secret default. **Not** identity. |

### Harness-stamped (never Agent-authored)

| Field | Law |
|-------|-----|
| `id` | Minted on create (like `finding_id`). Returned to the Agent. |
| `created_at` / `updated_at` | Clock on create / any mutate (including forget). |
| `source` | `agent` \| `user` from who invoked the tool — not a tool argument. |
| `created_task_id` | Task package id at create (for **New**). |
| `forget_count` | Incremented on each `forget`. 0 living; 1 soft-forgotten; ≥2 遗忘区. |
| `status` | Derived: `active` / `forgotten` / `sealed`. |
| `sensitivity` | Default from kind. |
| **New** | Projection, not a stored Agent flag: `created_task_id` = current Task (or first seen this Case burst). Same spirit as Finding **New**. |

Agent **must not** pass `id` on create (omit = create; pass `id` = update). Agent **must not** pass timestamps, `source`, or `new`.

---

## 1. Kinds (v1 closed enum)

Later kinds: **Spec amendment**, not an open string. Agent must not invent kinds.

| kind | Default secret | Stores |
|------|----------------|--------|
| `credential_status` | no | Status only (valid / invalid / untried). Password **material** → `secret`. |
| `secret` | **yes** | Password / cookie / token **value**. Inject: pointer only. |
| `token` | **yes** | JWT / shape / location; full value not auto-injected. |
| `flag` | **yes** | CTF flag. Dual-write to Finding is allowed when the pack books flags as findings; Intel may still hold the operational note. |
| `path_hint` | no | Worth-following path/param — not a scan dump. |
| `account` | no | Username/role enum; no password. |
| `config` | no | Version, WAF, default-page observations. |

**No v1 `note`.**

---

## 2. Lifecycle (notebook ≈ working memory)

Harness-stamped `forget_count` (Agent does not pass it).

| State | After | Agent | Operator |
|-------|--------|-------|----------|
| **Living** `active` | create / successful update of a living row | list, get, update, forget | 线索 section + 情报 tab |
| **Soft-forgotten** | **first** `forget` | **Not** in default list / inject / compact. `get(id)` and `record(id)` (update = correct the memory) still allowed. `forget` again → sealed. | Visible in 已遗忘 (not the living 线索 list) |
| **遗忘区 (sealed)** | **second** `forget` on that id (`forget_count ≥ 2`) | **Never** list, get, update, or inject. Tool calls on that id fail closed (`forgotten`). Fresh `record` with **no** id still creates a **new** living memory. | **遗忘区** — can open and read; not fed to the Agent |

Metaphor: new memories form (`record`); a biased memory is dropped or updated (`forget` once, or `record` on the same id); a memory discarded **again** leaves working mind and stays only in a human-inspectable 遗忘区.

- Lesson that should survive (“admin:admin is invalid”) = **new** `record` (new id), not reviving a sealed row.  
- Operator **purge** of a secret body remains UI/harness, not Agent forget.  
- v1 Agent surface stays **record + forget** only — no status enum in tool args.

---

## 3. Identity and writes

- Create → harness mints `id`. Update / forget → **by id**.  
- No composite key. No content-hash identity. No host auto-merge.  
- Duplicate NL clues stay two ids unless someone `forget`s the old id.

---

## 4. Where to hang (Agent judgment, not a keyword table)

Case is **never** the hang. Group hang is **not v1**.

| Observation is about | Hang |
|----------------------|------|
| Whole machine (OS, default creds, WAF, cert) | **Host** |
| One port / site | **Service** (existing Host+port) |
| No Host yet | Inventory / scope first (`create_asset` only when the user asked, or authorize / next-scope). **Do not invent a Host to hang intel.** |
| Unsure | **Host** (coarse beats wrong port) |

---

## 5. What is *not* Intel

Home-first. Intel is leftover operational memory about an **existing** asset.

| Discovery | Product home |
|-----------|----------------|
| New subdomain / IP / host | **Host** (user ask / authorize). Not a clue dump. |
| New internal CIDR | **Scope / next-scope**, then Hosts. |
| Path exists / tested | **Surface**. |
| Bookable vuln / pack flag-as-finding | **Finding**. |
| Reusable knowledge about an existing Host/Service that is none of the above | **Intel**. |
| Scan noise, one-off 404, retries | Discard. |

`kind` is not an admissions exam. Body is NL; pick the closest kind. Missing kind → still record (closest) rather than drop; add kinds later by Spec.

---

## 6. Persist cadence

Notebook, not a chore:

- **Mid-run:** optional. Record when something is worth keeping. **No** periodic write nudge.  
- **Compact threshold:** one persist pass (context-window Spec), then shrink. Agent may record or `forget` to 查漏补缺. Host does not extract. Empty pass still shrinks.  
- **Settle / after a burst:** operator reviews the 线索 section (New = harness). No confirm-all gate.

---

## 7. Tools (v1)

| Tool | Role |
|------|------|
| `platform_record_intel` | Create (no `id`) or update (`id`). Args: hang, kind, summary, body **only**. Harness fills id/audit. |
| `platform_list_intel` | Default **living** only. Never returns sealed. Soft-forgotten omitted unless a later explicit Agent filter is added (v1: omit). |
| `platform_get_intel` | Living or soft-forgotten: full row. **Sealed: not found** to Agent. UI may still open sealed in 遗忘区. |
| `platform_forget_intel` | `id` required. Harness ++`forget_count`. First forget → soft-forgotten; second → 遗忘区. |

Do **not** extend `platform_enrich_asset`. Do **not** let Agent set timestamps, `source`, or `new`.

---

## 8. UI

- **Asset dialogs:** existing Host / Service **情报** tabs — living rows by default; **遗忘区** filter for sealed (and optionally soft-forgotten). Group tab stays empty/honest; **no Group writes in v1**.  
- **Case right panel:** **not** a new tab. **线索** section in the Findings pane = living only (`id` + summary + New). A **遗忘区** entry (same pane or a disclosure under 线索 — **not** a new right-panel tab) lists sealed rows for the operator only.  
- Cards in chat must **not** invent a second list (same law as Findings projection).

---

## 9. Inject

- Cold `task_assign` / compact checkpoint: `intel_summary` = up to **20** **living** lines (id + summary + hang). Soft-forgotten and 遗忘区 **excluded**.  
- Secret kinds: summary/pointer only.  
- Distinct from existing `case_context.scope_intel` (that remains **prior findings**). Do not overload that field.

---

## 10. Non-goals

- Replacing Finding / Surface / Host create.  
- NLP extract from chat or stdout.  
- Group-hung intel in v1.  
- Open `note` kind.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-08-15 | First publish — map #459 / ticket #472. |
| 2026-08-15 | Notebook model: harness stamps id/audit/New; Agent record + forget only. |
| 2026-08-15 | Two-step forget: 1st = soft (update still allowed); 2nd = 遗忘区, user-only, never to Agent. |
| 2026-08-15 | Shipped: `asset_intel` + node/user APIs + citizen tools + Findings 线索 + Host/Service 情报. |
