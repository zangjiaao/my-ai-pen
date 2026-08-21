# Spec: HITL dual chrome — Approval wizard + Recommendation

**Status:** H0 frozen; H1 protocol + H3 wizard chrome in product (option cards). H2 Recommendation shell and H4 pack emit remain follow-up.  
**Tracker:** [#450](https://github.com/zangjiaao/my-ai-pen/issues/450)  
**Amends:** [`choice-card-next-steps.md`](choice-card-next-steps.md) / Spec [#312](https://github.com/zangjiaao/my-ai-pen/issues/312); [`free-tasks-continue-integrity.md`](free-tasks-continue-integrity.md) / Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313)  
**Orthogonal:** turn_trace [#449](https://github.com/zangjiaao/my-ai-pen/issues/449)

**Product path:** Node4 Graph × Pi + platform conversation UI. Same choice / `request_decision` channel — do not invent a parallel decision bus.

---

## Problem Statement

Human-in-the-loop decisions were forced through a single undifferentiated ChoiceCard: authorize is two buttons; next_steps is a flat list plus **optional supplement hanging on a pre-made option**. That is the wrong model for two operator jobs:

1. **Multi-question approval** — pager of questions; Send advances or submits the set; custom text may be **the answer itself**.
2. **Recommendation** — one preferred action with ranked alternatives (H2; protocol only in this slice).

Today’s next_steps card requires picking an option before submit (`picked.size > 0`) and labels the input 「补充说明（可选）」. Custom cannot stand alone.

---

## Product locks (grill)

| # | Lock |
|---|------|
| L1 | Same choice / `request_decision` family + optional `presentation`. No third WS type. |
| L2 | Two shells: **approval wizard** vs **recommendation**. Flat list is compatibility, not the product ideal. |
| L3 | **Submit = Send / Accept only.** Selecting a radio does not submit and does not auto-advance. |
| L4 | **Custom is a peer option** (last row in the option list), not a supplement. No `补充：` merge. Do not mint a platform `__custom__` option id. |
| L5 | **Single-select:** custom XOR pre-baked options (typing custom clears radios; picking a radio clears custom). **Multi-select** (only when Agent sets `selection: multi`): custom may coexist with checks. |
| L6 | Empty custom + no option selected → Send disabled. Custom-alone is valid when `allow_custom` (default **true**). |
| L7 | **✕ close = cancel** the whole wait (structured cancel / freeze; card remains in history read-only). |
| L8 | Host/Agent authors questions and options. FE must not ship demo question banks. |
| L9 | Existing #312 L9 freeze on free-text continue; interrupt freeze unchanged. |
| L10 | Option cards (`kind=next_steps` or structured `options[]` / `questions[]`) use **Approval wizard chrome**. A flat next_steps payload is projected as **one question** (question id `next_steps`); not a platform-invented option. |
| L11 | Authorize / handoff stay two-button until H2 Recommendation lands. Confidence meters only when host sends a signal. |
| L12 | Workset expand from selected option ids only (custom-alone expands nothing). |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Approval wizard** | Multi-question (or one projected question) presentation; answers submitted as a set. |
| **Custom option** | Last row: a text field that **is** an answer, not a note on another option. |
| **Recommendation** | Single primary action + Alternatives drawer (H2). |
| **Cancel (✕)** | Explicit end of HITL wait without accepting an option path. |

---

## Presentation

```text
presentation: "approval_wizard" | "recommendation" | "flat" | omit
```

**Default when omit:**

- `questions[]` valid → `approval_wizard`
- `kind=next_steps` or structured option objects → `approval_wizard` (L10)
- `kind` authorize / handoff / confirm without options → two-button authorize chrome
- Explicit `recommendation` only when host sets it (H2 FE later)

---

## Wire shape

```text
# Common
request_id, kind, presentation?, question? | title?, preamble?, allow_custom?

# Recommendation (H1 validate; H2 FE later)
options: [{ id, title, body?, workset_item_ids?, confidence?, cta_label?, rank? }]
primary_option_id?

# Approval wizard
questions: [{
  id, prompt, selection: single|multi,
  options: [{ id, title, body?, workset_item_ids? }],
  allow_custom: bool   # default true unless false
}]

# User decision
# cancel: decision cancel
# wizard / next_steps submit:
#   decision: confirm_options
#   selected_option_ids: union of chosen option ids (may be empty when custom-alone)
#   custom_text?: string          # convenience; 1-question custom-alone
#   answers?: [{ question_id, selected_option_ids?: [], custom_text?: string }]
#   text: built from options + 自定义 (never 补充)
```

Caps: wizard **1–8** questions; per question **0–8** options (0 only when `allow_custom`); option ids unique per card. next_steps card-level `options[]` still **2–5** with title+body when that array is the source.

---

## Chrome (Approval wizard)

Follow the ApprovalCard interaction, mapped to product ink/surface/hairline tokens (no demo copy, no box-shadow elevation):

- One question at a time; title row + ✕.
- Radio or checkbox rows; **custom input is the last row** (spacer, no extra radio).
- Footer: prev / dots / next when `questions.length > 1`; Send (arrow) always.
- Send on a non-last question with a valid answer → next question; on the last → submit all.
- Confirmed / canceled cards stay in the transcript read-only (no “start over”).

---

## Out of scope (this slice)

- Recommendation FE (primary + Alternatives + Accept) — H2.
- Pack/Node emit of multi-question `questions[]` as the default path — H4 (tool accepts the fields).
- Auto-submit or auto-advance on radio.
- Platform-generated fake questions.
- Merging HITL into turn_trace.

---

## Testing seams

| Seam | Prove |
|------|--------|
| **S1 pure validate** | Wizard / next_steps / authorize fixtures accept/reject. |
| **S2 decision reduce** | Custom-alone; radio XOR custom; multi may combine; empty blocked. |
| **S3 confirm text** | Custom renders as `自定义：`, never `补充：`. |
| **S4 workset bind** | Selected option ids still expand; custom-alone expands nothing. |
