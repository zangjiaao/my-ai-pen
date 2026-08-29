# Spec: Owner ledger Intel (线索 / 情报)

**Status:** Living — shipped (Host/Service 情报 tabs + Findings 线索 + Agent record/list/get/forget).  
**Tracker:** Map [#459](https://github.com/zangjiaao/my-ai-pen/issues/459) · draft [#472](https://github.com/zangjiaao/my-ai-pen/issues/472)  
**Decision source:** Hang + Intel≠Finding (map notes); lifecycle [#466](https://github.com/zangjiaao/my-ai-pen/issues/466); kinds [#469](https://github.com/zangjiaao/my-ai-pen/issues/469); identity [#470](https://github.com/zangjiaao/my-ai-pen/issues/470); write/read + persist cadence [#471](https://github.com/zangjiaao/my-ai-pen/issues/471).

**Product path:** Owner ledger (Group × Host × Service) + Case projection.  
**Amends:** `docs/specs/owner-ledger.md` — Intel wave was reserved (“not this wave”). This Spec **is** that wave.  
**Consumed by:** `docs/specs/context-window-management.md` (compact injects **living** intel ≤50 lines after a persist pass; this-Case + login first).

**Does not amend:** Finding identity / book-path L0 (#275); Case Surface (#368); intent NLP ban; pack Graph capability + user permission (no Expert caste).

---

## Problem

Operators and later Sessions lose **operational memory** that is not a Vulnerability: default password no longer works, JWT lives in a cookie, an account enum, a path worth retrying. Finding ledger must stay proof + severity. Chat is not SOT. The field case (`6a2e9e8a-…`) continued via prior vulns after a bad password — the missing object is **asset-hung clues**.

UI already has **情报** tabs with empty honest copy. Product law for the rows was missing.

---

## Solution

**Intel** = operational notes worth keeping **during testing** (how login works, which creds still valid, a path to retry) hung on a **Host** or **Service**. Not a Finding. **Not Evidence.** Evidence exists only to **support a booked vuln**; Intel is leftover process knowledge for the next turn / Session. The two directions do not overlap — do not copy Finding titles, PoC, or Evidence into Intel. Not a Case-owned dump. Case **projects** Scope ∩ living intel into the Findings pane (a **section**, not a new right-panel tab).

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
| `forget_count` | 0 not hard-forgotten; ≥1 **已忘记**. |
| `idle_case_count` | **Retired.** No longer drives UI or inject. Column may remain; harness must **not** increment for product fold. |
| `forgotten_by` / `forget_reason` | Hard forget only. `agent` must pass `reason`; `user` optional. |
| `access_count` | Incremented on **get(id)** (operator open / Agent `fact(get)`). List and compact inject do **not** increment. |
| `status` | Derived: `active` / `forgotten`. Unused-fold / `folded` is retired. |
| `sensitivity` | Default from kind. |
| **New** | Projection, not a stored Agent flag: written on **this Case** (`created_conversation_id`) or same Task package (`created_task_id`). Same spirit as Finding **New**. |

Agent **must not** pass `id` on create (omit = create; pass `id` = update). Agent **must not** pass timestamps, `source`, or `new`.

---

## 1. Kinds (v1 closed enum)

Later kinds: **Spec amendment**, not an open string. Agent must not invent kinds.

| kind | Default secret | Stores |
|------|----------------|--------|
| `credential_status` | no | Status only (valid / invalid / untried). Password **material** → `secret`. |
| `secret` | **yes** | Password / cookie / token **value**. Inject: pointer only. |
| `token` | **yes** | JWT / shape / location; full value not auto-injected. |
| `flag` | **yes** | CTF flag **value** as an operational leftover. Pack still books the vuln/flag as a **Finding** with **Evidence**. Do not put the Finding proof in Intel. |
| `path_hint` | no | Worth-following path/param — not a scan dump. |
| `account` | no | Username/role enum; no password. |
| `config` | no | Version, WAF, default-page observations. |

**No v1 `note`.**

---

## 2. Lifecycle (notebook ≈ working memory)

No unused-fold. Creating other Cases must **not** hide this Host’s notes.

| State | After | Agent | Operator right panel |
|-------|--------|-------|----------------------|
| **在用** `active` | create / upsert; not hard-forgotten | list, get, upsert, forget | **线索** (full Scope list) |
| **已忘记** `forgotten` | Agent `forget(id, reason)` or user 忘记 | Not in list / inject / get / upsert | **已忘记** — restore or delete; shows who + reason |

**This-Case** = `created_task_id` = current Task, or `last_used_conversation_id` = this Case (get / upsert / create). Used for inject always-include and operator pin — **not** a third status.

**Correct a clue:** `fact(upsert)` **on the same id**. `forget` is a hard drop and requires `reason`.

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
| No Host yet | Park the name on Case **Workset** (`workset(propose)`). Inventory / scope first (`create_asset` only when the user asked, authorize / Workset adopt, or Case enroll_group intake). **Do not invent a Host to hang intel.** |
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
| Proof that supports that Finding | **Evidence**. Never Intel. |
| How the app/auth/config actually behaves so the next probe can continue | **Intel**. Never Evidence. |
| Scan noise, one-off 404, retries | Discard. |

`kind` is not an admissions exam. Body is NL; pick the closest kind. Missing kind → still record (closest) rather than drop; add kinds later by Spec.

---

## 6. Persist cadence

Notebook, not a chore:

- **Mid-run:** `fact(upsert)` when something is worth keeping. **No** periodic write nudge.  
- **Compact threshold:** one persist pass (context-window Spec), then shrink. Agent may `fact(upsert)` or `fact(forget)` to 查漏补缺. Host does not extract. Empty pass still shrinks.  
- **Settle / wrap / next_steps:** one **optional** persist — write only clues the Agent judges worth the next Session. Skip if nothing new. Not a confirm-all gate; not a keyword scan of the user saying “总结”. Compact persist is a **different** pass; both may run in one Session.  
- **After a burst:** operator reviews the 线索 section (New = harness).

---

## 7. Tools (v1)

Agent surface is **`fact`** (same tool as this-task process keys). Host/Service 线索 is not a second platform_* family.

| `fact` op | Role |
|-----------|------|
| `upsert` | This-task `fact_key` plus living Intel when hang is known (`asset_id`, or the single on-ledger Scope Host). `kind` + summary + body. Harness stamps Intel id/audit. |
| `list` | Living Intel + this-task fact index. Never returns forgotten. |
| `get` | Living Intel `id` or local `fact_key`. Forgotten: not found. Each successful Intel get increments `access_count`. |
| `forget` | Intel `id` + **`reason`** (Agent required). Hard drop. `forgotten_by=agent`. |

Node HTTP `/api/node/ledger/intel` remains the harness path. Do **not** extend `platform_enrich_asset`. Do **not** let Agent set timestamps, `source`, or `new`.

---

## 8. UI

- **Asset dialogs:** existing Host / Service **情报** tabs — living rows by default; **已忘记** filter for archived. Group tab stays empty/honest; **no Group writes in v1**.  
- **Case right panel:** **线索** = all Scope ∩ not-hard-forgotten (no 50-cut; no 遗忘区). **已忘记** = hard forget (who + reason; restore / delete). Sort: this-Case new/used first, then `access_count` descending, then `updated_at`. Scope filter unchanged.  

- Access count is an **eye + number** on the row and on the Finding-style detail dialog. Not a second tab.
- Cards in chat must **not** invent a second list (same law as Findings projection).

---

## 9. Inject

- Cold `task_assign` / compact checkpoint: `intel_summary` = **Scope ∩ living**, then an **Agent window** of **N=50** (override `MYAIPEN_INTEL_INJECT_WINDOW`, clamp 1–200). Forgotten **excluded**. Operator 线索 is **not** windowed.  
- Hang filter (inject and Case 线索 share it): Case Host membership = **authorized Scope** (`scope.asset_ids` or unique primary∪alias match on `scope.allow`) **or** a this-Case Surface origin that **uniquely** matches an owner Host. Ambiguous identity (2+ Hosts) does not join. Then **Host-level** (no port) **+ Scope Service ports** from structured `target` / `scope.allow` (explicit `:port` or `port` field — no invented 80/443; allow=`localhost:3000` maps onto the owner Host that has alias `localhost`). If Scope names a Host with **no** port, that Host is whole-Host (all Service intel). `fact(list)` / asset 情报 tabs are **not** this filter — Agent can still open a sibling-port id. Agent must not copy intel into Case-private rows; hang on the Host via `fact`.  
- Window is **Scope-local**, never a global popularity contest across other Hosts.  
- **Lane A (always, newest first if over cap):** this-Case new/used + login kinds (`credential_status` / `secret` / `token` / `account`).  
- **Lane B:** remaining by `access_count` desc, then `updated_at`. Fill until N.  
- Render **before** prior-finding dumps (`scope_intel` / this-Case findings board). Summary is enough to act — recorded valid creds are the login path (do not recover via defaults / hash dump / booked RCE). Body via `fact(get)`, not `platform_get_intel` (that tool is not on the Expert pack).  
- Secret kinds: summary/pointer only.  
- Distinct from existing `case_context.scope_intel` (that remains a **prior-finding index**: path/module-folded title + one-line summary on Scope ports — not a retest queue). Do not overload that field.

---

## 10. Non-goals

- Replacing Finding / Surface / Host create.  
- NLP extract from chat or stdout.  
- Group-hung intel in v1.  
- Open `note` kind.

---

## Changelog

| 2026-08-29 | Spec #540: no Host yet → park on Case Workset; do not invent a Host to hang a Shodan/CT row. |
| 2026-08-15 | Notebook model: harness stamps id/audit/New; Agent record + forget only. |
| 2026-08-15 | Two-step forget: 1st = soft (update still allowed); 2nd = 遗忘区, user-only, never to Agent. |
| 2026-08-15 | Shipped: `asset_intel` + node/user APIs + citizen tools + Findings 线索 + Host/Service 情报. |
| 2026-08-15 | Agent surface merged into `fact` (upsert/list/get/forget). platform_*_intel is harness HTTP only. |
| 2026-08-15 | `access_count` harness stamp on get(id); UI eye + number. |
| 2026-08-15 | Settle persist: optional wrap/next_steps notebook write; compact persist remains a separate pass. |
| 2026-08-15 | `fact(op=surface)` removed. Attack surface is the `surface` tool; harness may copy deposits into `facts/`. |
| 2026-08-15 | Case inject / 线索: Host-level + matching Scope Service ports; sibling ports on the same Host excluded. |
| 2026-08-15 | Inject: living notebook before prior dumps; login kinds first; summary is enough to act; body via `fact(get)`. |
| 2026-08-16 | Right-panel 线索 / 已遗忘 lists sort by `access_count` descending. |
| 2026-08-16 | Unused fold (3 Cases, harness) vs hard forget (agent reason / user). Panel: 线索 / 遗忘区 / 已忘记. |
| 2026-08-15 | Intel ≠ Evidence: Evidence supports Findings only; Intel is in-test operational notes. No restating booked proof into the notebook. |
| 2026-08-17 | Unused-fold / 遗忘区 retired. Agent inject = two-lane window (this-Case + login, then frequency, N=50). Operator 线索 = full Scope list, same sort. |
| 2026-08-17 | New + pin = this Case (`created_conversation_id`), not only current Task package. Snapshot stamps `is_new` with Case id. |
| 2026-08-28 | Case Host membership for 线索/inject: authorized Scope ids or unique identity/Surface-origin match; aliases count; Agent does not copy intel into Case-private rows. |
