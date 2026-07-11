# Node2 Harness v2 — OMP-aligned attack loop

> **Execution north star for Node2 runtime changes.**  
> Calibrated: 2026-07-11  
> Inspired by oh-my-pi (OMP) “simple is strong”, without cloning OMP or hardcoding target answers.

Related: `product-roadmap.md` (execution entry), `architecture.md` (platform/node boundaries), `product-vision.md` (product goals).

---

## 1. North star

Node2 is an **authorized security attack harness** with a thin product fact layer—not a multi-gate scanning state machine.

```text
Understand → Map (todo) → Act (http/browser/script) → Book (finding+evidence) → Advance (todo) → Close (finish)
```

Default: **one main agent**. Workers are optional accelerators. Progress is a map, not a prison.

OMP taught us: same-class models win with fewer abstractions, scripted multi-step exploits, and a silky todo that does not block completion.

---

## 2. Design principles

1. **Simple is strong** — main loop ≤ 5 steps; default tool surface small.
2. **Exploit first, book second** — confirm findings only after real evidence; never test only to pass a gate.
3. **Todo is a map** — phases + short tasks; single `in_progress`; auto-promote next; **never the sole rejector of `finish(completed)`**.
4. **Scripts are first-class weapons** — multi-step chains use `poc` write/run (sandbox), not twenty atomic http calls.
5. **Stores are projections** — traffic / evidence / finding / coverage record truth; they do not own the user-facing task list.
6. **Engagement sets success** — assess / verify / retest / consult (and future challenge) via structured fields or the workflow actually run—not keyword NLP.
7. **Harness over restriction** — weak detection → improve loop/prompt/tools; do not add validators as the default fix.
8. **No target-specific answer keys** — no hardcoded DVWA/Juice/CTF flag lists in production paths.

---

## 3. Main loop

| Step | Agent action | Tool |
|------|----------------|------|
| 1 Understand | Target, scope, engagement | workflow once if needed |
| 2 Map | Full phase list for the request | `todo` `init` |
| 3 Act | Hit real surface | `http` / `browser` / `poc` / `scan` / `traffic` / `actor` |
| 4 Book | Confirm with evidence | `finding` + evidence_ids |
| 5 Advance | Mark done; next auto-starts | `todo` `done` (same turn OK) |
| 6 Close | One terminal status | `finish_scan` |

Same turn after `todo init` / `todo done`: continue acting. Do not spend a whole turn only updating bookkeeping.

---

## 4. Todo semantics (OMP-like)

Ops (single op per call): `init | start | done | drop | rm | append | view`.

- Task identity = **verbatim content string** (not `task-1` IDs).
- Task label: **5–10 words**, what not how; phase names short nouns.
- Status: `pending | in_progress | completed | abandoned`.
- **At most one** `in_progress` globally; `done` auto-promotes the next `pending`.
- Failed ops discard mutations (atomic).
- **Main agent owns todo**; workers do not.
- User-visible Tasks UI should track todo phases (projected into plan events if needed).

### Todo vs finish

| | Todo | Finish |
|--|------|--------|
| Role | Progress map / UI | Terminal engagement outcome |
| Blocks completed? | **No** | Only evidence/engagement rules |
| Soft nudge | Yes (open items) | Prefer `incomplete` when work remains |

---

## 5. Tools (intent)

**Progress:** `todo`

**Act (default path):** `http`, `browser`, `poc` (write/read/run scripts), `traffic`, `actor`, optional `scan` / `verifier`

**Book:** `finding`

**Close:** `finish_scan`

**Optional:** `worker` for narrow parallel packages only

**Demoted from main path:**

- `coverage(action='plan')` as the user checklist (use `todo` instead)
- Mandatory multi-worker / workPackage dispatch before finish
- Open intentional checklist as a hard `finish_scan(completed)` reject
- Coverage conversion / family / bulk-skip gates as the *only* path to completed when evidence already exists (soft guidance preferred; evidence-oriented complete)

Coverage remains useful for mark / next_work / surface quality—navigation, not ceremony.

---

## 6. Engagement success rules

| Engagement | Hard complete | Soft guidance |
|------------|---------------|---------------|
| assess | Evidence-backed findings **or** explicit no-finding with real attempt notes | Broad surface, multi-actor when multi-user |
| verify | Hypothesis confirmed or disproved + evidence | Stay on stated path |
| retest | Fixed / still open + evidence | Original issue only |
| consult | Clear answer | Live tools only if authorized |

No free-text keyword routing for engagement. Structured `task.engagement` or workflow actually run.

---

## 7. What we demote (do not rebuild)

- Plan checklist as finish gate
- Default multi-worker orchestration tax
- Long system prompts that encode full scan state machines
- New specialized Nodes per role (surface / post-ex / CTF) until hard capability boundaries force a split
- Target-specific profiles and expected vuln counts

---

## 8. Delivery phases

| Phase | Deliverable |
|-------|-------------|
| A Docs | This page + roadmap/architecture pointers |
| B Todo + finish | TodoStore/tool; remove checklist hard reject; project todo to Tasks |
| C Prompt | Single-agent act→book→advance; script-first; workers optional |
| D Script path + smokes | `poc` first-class; harness smokes; evidence-oriented finish |
| E Compare | Node2 vs OMP on CTF / DVWA / Juice (honest residual gap OK) |

---

## 9. Success metrics

- Same model, lab targets: detection / flags / challenges move toward OMP baselines without answer keys.
- Visible loop: `todo init` → act → `finding` → `todo done` → `finish_scan`.
- System prompt shorter; default ceremony lower; Tasks UI = todo tree.

---

## 10. Non-goals

- Full OMP clone or Pi replacement
- Platform frontend redesign beyond todo wiring
- Exact OMP score parity as a pass bar
- Production Caido perfection as a blocker for harness simplification
