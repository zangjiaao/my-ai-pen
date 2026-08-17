# Spec: Composer restore on Case open (current Mention + Session mode + Goal)

**Status:** Implementable Spec (product contract) — **living**  
**Tracker (to-spec / `ready-for-agent`):** [#474](https://github.com/zangjiaao/my-ai-pen/issues/474)  
**Decision source:** Owner discussion (2026-08-17) — refresh / leave conversation route remounts `ConversationPage`; composer partner + Graph + Goal reset to Spec #299 default (usually 通用助理). Operators who were addressing a pentest Expert must re-select and often wait for another Expert transfer.

**Product path:** Platform conversation UI + Node4 Graph × Pi (ADR 0001).  

**Amends (thin restore UX only):**  
- [`participant-session.md`](participant-session.md) / Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) — current Mention + Session work-mode continuity must survive **UI remount**, not only interrupt→continue.  
- [`graph-catalog-work-mode-ui.md`](graph-catalog-work-mode-ui.md) / Spec [#278](https://github.com/zangjiaao/my-ai-pen/issues/278) — D3 “sync composer once after settlement” also applies **once on Case open** from Session actual.  
- [`composer-graph-harness-bind.md`](composer-graph-harness-bind.md) / Spec [#284](https://github.com/zangjiaao/my-ai-pen/issues/284) — B5 still holds: Case sticky `engagement_template` alone must not restore Graph onto the composer.

**Does not amend:** work-envelope policy, Expert transfer permission, #299 new-chat default for a **blank** home, intent NLP ban (`AGENTS.md`).

---

## Problem Statement

The composer bar (对话对象 / Graph 不指定-or-template / Goal) is React state on the conversation page. Two everyday actions wipe it:

1. **Refresh** the Case URL.  
2. **Leave** `/` or `/:caseId` (dashboard, 专家管理, assets, …) and come back — sibling routes unmount the page.

On remount the picker is `null`, so the page re-applies Spec #299: `is_default` → `pack=default` 通用助理 → first online seat. The operator who has been talking to 渗透 sees the default assistant, sends (or waits for a handoff), and the assistant must transfer back.

That is not a missing persist layer. The Case already stores:

- current Mention / sticky expert on `conversation.context.task.expert_id`  
- Participant Session `work_mode` / `graph_id` on `context.sessions[expert_id]`  
- Goal on `task.goal_mode`

The composer does not read those fields on open. Component state cannot survive remount; a browser-global last pick would also be the wrong model (see Solution).

---

## Solution

**Scheme 1 — bind composer restore to the open Case.** Reject Scheme 2 (one browser-wide last partner/mode for every Case).

On **open or switch Case**, restore the composer **once** from that Case’s snapshot:

| Control | Restore from | Must not restore from |
|---|---|---|
| 对话对象 | Case current Mention (`task.expert_id`, already written on send / authorized transfer) | Spec #299 default while a live Case Mention exists; another Case’s last pick; `localStorage` as Case SOT |
| Graph control | **That expert’s** Participant Session `work_mode` / `graph_id` | Case sticky `engagement_template` (#277 A1 / #284 B5) |
| Goal | `task.goal_mode` **only if** the restored partner is a pentest seat | Non-pentest partners; inventing Goal from free text |

Rules:

1. Session **Graph** → composer shows that product Graph id (same one-shot align as `work_mode_settled`).  
2. Session **Free** or no Session record → composer **不指定** (`null`), even if Case sticky still says `app_assessment`.  
3. Mention expert missing, disabled, or not schedulable → fall back to #299 default; do not keep a dead chip.  
4. **Blank `/`** (no Case) → #299 default. Optional `sessionStorage` may keep an **unsent blank-home draft** (partner + Graph + Goal) and **must** be discarded as soon as a Case exists.  
5. Switching Case A → Case B restores **B**, never leaks A’s composer. Opening blank home clears Case composer (no bleed onto a new chat).  
6. Heartbeat `GET /state` / mid-session snapshot **must not** overwrite composer (#278 D3). Only: this once-per-open restore, user menu edits, authorized `partner_switch`, and `work_mode_settled`.  
7. Unsent Mention / Graph / Goal change on an **existing** Case is a draft. Remount of that Case restores last **committed** Case/Session fields (send or authorized transfer / mode settlement), not an unsent chip flip. Blank-home draft is the only unsent exception.

Next send still follows existing wire law: explicit composer Graph is permission (#284 B1); 不指定 is no force mode change (#278 A1). Restore only puts the chips back; it does not invent engagement or mode.

---

## Product locks

| # | Lock |
|---|------|
| **L1** | Composer restore is **Case-bound**. One browser last-pick shared by all Cases is forbidden. |
| **L2** | Partner restore source is Case current Mention (`task.expert_id`). |
| **L3** | Graph restore source is Participant Session `work_mode` / `graph_id` for **that** expert. |
| **L4** | Case sticky `engagement_template` **must not** set composer Graph on restore. Session Free + sticky Graph → 不指定. |
| **L5** | Goal restore only for a pentest restored partner and only from structured `task.goal_mode`. |
| **L6** | Restore runs **once per Case open / switch**, not on snapshot heartbeat. |
| **L7** | Blank home uses #299. No Case ⇒ no Case restore. |
| **L8** | Blank-home `sessionStorage` (if implemented) is not Case SOT and is dropped when a Case id exists. |
| **L9** | Offline / deleted restored expert → #299 default (same selectable gate as live picker). |
| **L10** | No platform NLP / keyword table inventing partner, Graph, or Goal from chat text. |
| **L11** | Text draft in the input box is **out of this Spec** as Case SOT (may stay component-local). |
| **L12** | Do not “fix” remount by keep-alive-mounting the conversation page across `/experts` etc. Restore from Case/Session fields. |

---

## Domain terms

Use existing glossary (`CONTEXT.md` + #277). Do not add a third “composer session”.

| Term | Meaning here |
|---|---|
| **Case current Mention** | Who the operator is addressing on this Case. Persisted as sticky `task.expert_id`. |
| **Participant Session** | `conversation_id + expert_id`. Owns work mode / parked Graph. |
| **不指定** | Composer omit — no force mode change. Not “Agent may pick Graph”. |
| **#299 default** | New / blank partner priority: `is_default` → `pack=default` → first online schedulable. |
| **Once-on-open restore** | One apply when the Case snapshot + mention catalog are ready for that Case id. |

---

## Seams (test high)

Prefer **one primary pure seam**. Do not add a second persist store.

| Seam | Behavior |
|---|---|
| **S1 Composer restore resolver (primary, pure)** | `(snapshot, mentionTargets) → { partner, engagementTemplate, goalMode }`. Partner from `task_context.expert_id` matched to a schedulable mention; Graph from that expert’s Session (`sessions[expert_id]` or already-projected AgentRow `work_mode` / `graph_id` on the snapshot); Goal from `task_context.goal_mode` iff pentest partner. Missing/offline expert → #299 default + 不指定 + Goal off. Session Free + Case sticky Graph → 不指定. |
| **S2 Case-open apply (thin adapter)** | Conversation page calls S1 **once** when Case id + snapshot + mention catalog are ready. Switching Case or opening blank home resets then reapplies (or #299). `refreshConversationState` / heartbeat does **not** call S1. |
| **S3 Snapshot fields (only if S1 cannot see Session mode)** | Prefer existing `/state` fields (`task_context`, `strix_agents` / participants already lifting Session `work_mode`). Add a thin `sessions` / composer-restore projection **only** if those fields are absent for idle Cases. Do not invent a new SOT. |
| **S4 Blank-home draft (optional)** | Isolated `sessionStorage` key for `/` with no Case. Discard on first Case id. Never read when `/:caseId` is open. |

Primary unit seam: **S1**. Highest integration: open Case after remount → chips match last committed Mention + Session mode; next send still obeys #277 / #278 / #284.

---

## User Stories

1. As an operator, I want refresh on a pentest Case to keep 渗透 selected, so that I do not re-pick the partner.  
2. As an operator, I want leaving to 专家管理 and coming back to the same Case to keep 渗透, so that I do not wait for another transfer.  
3. As an operator, I want the Graph chip to show the Session’s actual Graph after remount, so that the bar matches the work I left.  
4. As an operator, I want a Free Session to come back as 不指定 even if the Case once ran 应用评估, so that「继续」does not look like a Graph relaunch.  
5. As an operator, I want Goal still on after remount when I had Goal on for that pentest Case, so that the next send does not silently drop Goal.  
6. As an operator, I want Goal off after remount when I had turned it off, so that sticky Goal does not revive from a missing chip.  
7. As an operator, I want opening Case B (助理) after Case A (渗透) to show 助理, so that Cases do not share one picker.  
8. As an operator, I want a new blank chat to start at the #299 default, so that “New” is not secretly last week’s Expert.  
9. As an operator, I want an unsent partner change on a blank home to survive a quick trip to another page (if blank draft ships), so that I do not re-pick before the first send.  
10. As an operator, I want that blank draft gone once the first Case exists, so that it cannot override Case B later.  
11. As an operator, I want changing Graph in the composer mid-session without sending, then getting a `/state` refresh, to keep my draft chip, so that heartbeats do not fight me.  
12. As an operator, I want remount after an unsent chip flip on an **existing** Case to show last committed Mention/Session, so that unsent clicks are not a second SOT.  
13. As an operator, I want an authorized handoff to update the chip and the next remount, so that transfer and restore tell the same story.  
14. As an operator, I want a cancelled handoff to keep the current Mention on remount, so that restore does not complete the transfer.  
15. As an operator, I want a deleted or offline restored Expert to fall back to a schedulable default, so that I cannot address a dead seat.  
16. As an operator, I want a non-pentest restored partner to hide/clear Graph and Goal, so that those controls do not appear on 通用助理.  
17. As an Expert Agent, I want remount not to change who the next user message is addressed to, so that I do not see a surprise transfer.  
18. As a Default-seat Agent, I want opening a Case whose Mention is still me to stay me, so that I am not replaced by last-browser pentest.  
19. As a platform implementer, I want one pure restore function, so that Case-open and tests share the same policy.  
20. As a platform implementer, I want to reuse `task_context` + Session/AgentRow fields, so that we do not add localStorage as Case SOT.  
21. As a platform implementer, I want heartbeat apply to stay D3-clean, so that restore cannot regress #278.  
22. As a QA engineer, I want a fixture Session Free + Case sticky `app_assessment` → composer 不指定, so that A1/B5 stay tested at this seam.  
23. As a QA engineer, I want a fixture Case A pentest / Case B default that do not leak, so that Scheme 2 cannot sneak in.  
24. As a QA engineer, I want a fixture missing `expert_id` → #299 default, so that first-open blank-ish Cases stay honest.

---

## Implementation Decisions

1. **No new persist API.** Send and authorized `partner_switch` already write sticky `task.expert_id`. Envelope settle already writes `sessions[expert_id].work_mode` / `graph_id`. Goal already sticks on `task.goal_mode`. This Spec is **read-on-open**.  
2. **S1 is a pure helper** next to existing composer/mention helpers (not a second policy in Node, not keyword intent). Inputs are structured snapshot fields + the mention catalog only.  
3. **Partner match** is `expert_id` against mention targets (`kind=expert` and schedulable). Do not match on pack id alone (two pentest Experts on one Case must not collapse).  
4. **Graph map** uses the same product ids as today’s settlement handler (`app_assessment`, `redteam_deep`, `hypothesis_cycle`, plus existing aliases). Unknown graph id → 不指定 rather than invent a chip.  
5. **Apply timing:** after Case snapshot is applied **and** mention targets have loaded; gate with the Case id so a late catalog fetch cannot apply Case A onto Case B.  
6. **Case switch / blank home:** reset composer (partner/Graph/Goal) before restore or default so A cannot bleed. Today’s conversation reset does **not** clear composer — that leak is in scope.  
7. **Heartbeat:** keep the existing “do not overwrite `engagementTemplate` from Case sticky / refresh” comment as a testable contract; partner and Goal follow the same rule.  
8. **S3:** only if idle snapshot AgentRows omit Session mode. Prefer lifting from `context.sessions` in the existing participants/AgentRow projection over a one-off FE parser of raw context.  
9. **S4** is optional in the first PR. If skipped, blank-home remount stays #299 (documented). If shipped, key must not be the same as last-active Case id cache.  
10. **Docs:** this file + `docs/README.md` index; thin pointers on #277 / #278 / #284. Same change as the implement PR when behavior lands; this record may ship first as docs-only.

---

## Testing Decisions

- **Good tests** assert S1 outputs from structured fixtures (snapshot + mention list). They do not inspect React state internals or screenshot the chip.  
- **Must pass:**  
  - pentest `expert_id` + Session `graph` `app_assessment` → that partner + that template  
  - same partner + Session `free` + Case sticky `app_assessment` → partner + **不指定**  
  - missing / offline expert → #299 default + 不指定 + Goal off  
  - non-pentest partner → Goal off and no Graph template  
  - `goal_mode: true` + pentest partner → Goal on  
  - `goal_mode: false` + pentest partner → Goal off  
- **Adapter tests (S2):** restore is not invoked from heartbeat refresh; Case switch applies the new Case; blank home does not keep the previous Case partner.  
- **Prior art:** `participant_session` envelope tests (A1 / sticky must not force Graph); frontend `experts.wire.test.ts` (non-pentest never sends template); ConversationPage composer isolation test (draft text stays out of page state).

---

## Out of Scope

- Scheme 2: browser-global last partner / last Graph for all Cases.  
- Keep-alive / layout `Outlet` so the conversation page never unmounts.  
- Persisting the composer **text** draft as Case or Session SOT.  
- Changing work-envelope resolution, silent Graph promote, or Expert transfer permission.  
- Changing #299 default for a true blank new chat.  
- Multi-Expert true-parallel run (v1 still one current Mention).  
- New persist columns or a dedicated composer-preference table.  
- Platform NLP invent of partner / mode / Goal.

---

## Further Notes

Rejected alternative (Scheme 2) in one line: a single `localStorage` last pick makes Case B inherit Case A’s 渗透 (or the reverse after a blank-home flip). Backend continue already hydrates sticky expert; UI showing a different partner is a split-brain that forces another handoff.

This Spec does not make Case sticky template authoritative. It only makes the **already authoritative** Case Mention + Session mode visible on the composer after remount.

## Changelog

| Date | Change |
|------|--------|
| 2026-08-17 | First publish — #474. Scheme 1 Case-bound restore; Session mode not Case sticky; #299 blank default. |
| 2026-08-17 | Implemented S1/S2/S3. S4 blank-home draft not shipped (blank remount stays #299). |
