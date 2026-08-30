# Spec: Session-first dialogue path (Task out of conversational middle)

**Status:** Implementable Spec (product contract) — **living**  
**Tracker:** [#455](https://github.com/zangjiaao/my-ai-pen/issues/455)  
**Decision source:** Field Case `174c4ac6-…` (terminated →「继续」; park hit + engagement-book rewrap felt like Session restart); product demand that Task stay dispatch/accounting, not dialogue author.

**Product path:** Platform conversation UI + Node4 Graph × Pi (ADR 0001).  

**Amends (thin dialogue-path rules only):**  
- [`session-owns-runtime.md`](session-owns-runtime.md) / Spec [#354](https://github.com/zangjiaao/my-ai-pen/issues/354) — Session owns captain runtime; this Spec adds **what the model sees as the user turn** on continue.  
- [`participant-session.md`](participant-session.md) / Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) — same-mode continue retains Session; dialogue body is not a new Task book.  
- [`free-tasks-continue-integrity.md`](free-tasks-continue-integrity.md) / Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313) — Free Tasks integrity unchanged; confirm text remains operator-authored turn text.  
- [`prompt-layers.md`](prompt-layers.md) / Spec [#386](https://github.com/zangjiaao/my-ai-pen/issues/386) — cold/first-turn layers may be heavy; park-hit turn body stays thin.

**Does not amend:** Finding Store / book-path L0, owner ledger, intent NLP ban, pack Graph capability + user permission (no Expert caste), work-burst / package accounting, Session auto-title ([#457](https://github.com/zangjiaao/my-ai-pen/issues/457)).

---

## Problem Statement

Operators talk to a **Participant Session** on a Case. After model failure or interrupt they say「继续」and expect the same Expert conversation to resume.

What they see instead often feels like a restart: a new Task package id, a long re-authored engagement brief with `User continuation: …` glued onto the prior instruction, heavy Case re-injection on every continue, and Tasks progress that looks 0/N — even when Node park attach kept the same pi session.

**Task is useful for timing, cancel, attribution, and UI lights.** It must not sit between the user and the Session as a second author of the dialogue turn.

---

## Solution

1. **Session-first dialogue:** model-visible user turn = operator utterance (or ChoiceCard confirm text).  
2. **Continue** = next Session turn when park hits; new package id may exist for accounting only.  
3. **No engagement-book rewrap** on same-Session continue (no sticky prior instruction + `User continuation:` glue as the turn body). Target / scope / RoE stay **structured** on the envelope.  
4. **Heavy case_context / first-turn harness** on cold start or honest park miss only.  
5. **Task/package remains** for work-burst, interrupt, attribution, Graph packages, collab lights — side channel, not dialogue middle.  
6. **UI narrative** prefers Session continue over “new Task” when park-hit; package fail ≠ Case/Session death (display law stays [#354](https://github.com/zangjiaao/my-ai-pen/issues/354)).

---

## Product locks

| # | Lock |
|---|------|
| **L1** | Same-Session continue turn text = **operator utterance only** (or ChoiceCard confirm display text). Harness continue is not a user turn. |
| **L2** | Platform must **not** concatenate sticky prior `instruction` + `User continuation: …` into `text` / `initial_instruction`. |
| **L3** | Sticky **target / scope / RoE / expert / engagement / goal** remain structured fields on the envelope (not prose paste into the turn body). |
| **L4** | New `task_id` on continue is **allowed** for accounting; minting a package id must not imply dialogue restart. |
| **L5** | Park-hit (Node attach): captain prompt = user utterance only — **no** cold multi-block first-turn rebuild as the turn body. |
| **L6** | Park-hit: do **not** require full `case_context` / eager harness re-injection into the user turn; cold start and honest park-miss may inject fully. |
| **L7** | Free Tasks / Todo integrity (#313) unchanged: no silent init wipe on continue. |
| **L8** | Graph package boundary retained: Free continue ≠ incomplete Graph resume semantics; mode continuity stays #277 / #282. |
| **L9** | No platform free-text keyword table inventing engagement / mode / Task book content (AGENTS.md). Sticky restore uses structured snapshot fields only. |
| **L10** | Handoff / first open-engagement may still use a full structured cold **system** envelope (This turn Case / Target / Scope + optional `### Handoff` card body). **User turn stays the operator utterance.** `proposed_action` is never `initial_instruction`. |

---

## Domain terms

| Term | Meaning |
|------|---------|
| **Dialogue turn text** | Model-visible user message body for this turn (`task.instruction` / `initial_instruction` on Node). |
| **Engagement-book rewrap** | Illegal composite: prior sticky instruction + `User continuation:` + new utterance as one turn body. |
| **Package / Task id** | Dispatch and accounting identity for lights, cancel, work-burst — not Session dialogue author. |
| **Park-hit** | Node attaches existing captain pi for `(conversation_id, expert_id)`. |
| **Park-miss** | No live park (dispose, process death, Reset reseed) → honest cold reseed path. |
| **Cold envelope** | First-open or park-miss path: system layers + case_context + authorized Scope (legacy envelope target if present) + user utterance. |

---

## User Stories

1. As an operator, I want「继续」after model failure to feel like the same Expert conversation.  
2. As an operator, I want the Agent to see my short message, not a multi-paragraph task book.  
3. As an operator, I want sticky target/scope without prose paste into chat.  
4. As an operator, I want package ids for timing/stop without “new Session” narrative.  
5. As an operator, I want package fail ≠ dead Case.  
6. As an operator, I want park-hit to keep pi memory; park-miss to reseed honestly.  
7. As an operator, I want Free Tasks progress to survive continue without silent wipe.  
8. As an Expert Agent author, I want only the user turn to be new on continue.  
9. As a platform implementer, I want one continue path without composite instruction.  
10. As a Node implementer, I want park continue `prompt(userUtterance)` only.  
11. As a QA engineer, I want S1–S3 fixtures (envelope text, park prompt, injection policy).  
12. As an operator, I want ChoiceCard confirm to continue with my confirm text + sticky target, not a rewritten book.  
13. As an operator, I want cold first open to still get full harness context, so first engagement is not under-informed.  
14. As an operator, I want park-miss to still seed open Free todos when product policy requires (#313 / #354), so progress is not silently lost.  
15. As a developer, I want sticky instruction snapshot updates to store the latest utterance without accumulating composite essays.

---

## Implementation Decisions

### Seams

| ID | Seam | Owner | Behavior |
|----|------|-------|----------|
| **S1** | Continue / resume envelope | Platform | Sticky target/scope/goal/checkpoint merge **without** instruction rewrap; `text` / `initial_instruction` = operator utterance. |
| **S2** | Park attach prompt | Node | `session.prompt(task.instruction)` only; no multi-block cold user prompt rebuild. |
| **S3** | Injection policy | Node (+ platform attach allowed) | Full `case_context` / eager harness on cold or park-miss; park-hit thin (omit turn-body case_context inject). |

### Platform

- `_resume_message_from_context` (and any twin): restore structured sticky fields; **never** build `prior + "User continuation:" + next`.  
- Terminal/idle package states (`failed` / `incomplete` / `paused` / `canceled` / `completed`) + durable sticky target → same-Session continue: hydrate sticky expert, restore structure when turn lacks target, set `session_continue`.  
- `_task_assign_from_user_message` maps utterance → `initial_instruction` (and carries `session_continue`).  
- `_remember_conversation_task` may store the latest utterance as sticky instruction snapshot (short); do not re-grow a composite book. Row-lock the Conversation; do not write a stale envelope `scope` over the live persisted Scope / Workset.
- `case_context` may still be **attached** on wire for cold/park-miss consumers; park-hit must not **require** it for a valid turn.  
- New `task_id` on continue is normal (L4); not a dialogue restart signal.

### Node

- `runParkedWorkingContinue`: keep single `session.prompt(task.instruction \|\| "继续")` (operator channel).  
- Cold Free / Graph first prompt paths retain case_context + target/scope blocks (Spec #386 layers).  
- Park-miss reseed uses cold path honesty (Todo seed / handoff rules unchanged).  
- Lab outer continue / goal / budget injects use `session.prompt(..., { channel: "harness" })` — product `role=harness`, markdown `## Runtime` / `### Continue`. Never a fake operator user turn. Occupancy persist-pass and checkpoint are the same channel. Mid-run todo/booking/surface nudges append to the tool result.  
- **Case speech:** unread visible talk (who said what — not thinking/tools) arrives as harness `### Case speech` on the same prompt as the operator utterance (`prefixHarness`). Cursor lives on the parked runtime. Cold / park-miss starts empty (recent window once). Park-hit is delta only. **isSelf = current pi `session_id`**, not `expert_id` — a new working runtime of the same Expert still receives prior visible talk. System does not re-inject `### Thread`.

### Phases

| Phase | Status | Notes |
|-------|--------|--------|
| **P0 — S1 rewrap removal** | **Done** | `_resume_message_from_context` utterance-only; sticky structure + `session_continue` on wire. |
| **P1 — S2/S3 park thin inject** | **Done** | Park path `prompt(utterance)` only; cold/park-miss still may inject case_context. |
| **P2 — UI narrative** | **Done** | Package light titles = 本段错误/本段已中止; **persist + live** settle copy uses Package / Session continue (not “Task complete”); park `task_start`/`task_complete` carry `session_continue`. Stream still suppresses ordinary status chrome (#326). Field Case `6a2e9e8a-…` verified S1/S2 (issue comment). |
| **P3 — Session-scoped dirs** | Deferred | Optional; not required for dialogue-path honesty / v1 test. |

**Wire flag:** `session_continue: true` on `task_assign` when same-Session continue (accounting package mint allowed).

---

## Testing Decisions

Test **external behavior** at seams S1–S3 only.

| Seam | Prove |
|------|--------|
| **S1** | Sticky resume with「继续」→ `text` / `initial_instruction` equal user utterance; target/scope present; **no** `User continuation:` and **no** prior instruction body in turn text. |
| **S2** | Park-hit prompts the utterance string only (existing park continue fixtures). |
| **S3** | Park-hit path does not rebuild cold multi-block user prompt; cold/park-miss still may inject case_context / Todo seed. |

**Prior art:** `tests/test_checkpoint_resume.py` resume helpers; `node4` `working-session-park.test.ts` / `runParkedWorkingContinue`; participant envelope / free-tasks continue tests.

**Avoid:** treating “new task_id minted” as proof of dialogue restart (mint is allowed under L4).

---

## Out of Scope

- Deleting Task/package ids or work-burst accounting.  
- Finding Store / book-path L0 / owner-ledger identity changes.  
- Keyword intent routing / inventing engagement from free text.  
- A pack executing work its tools/skills do not support (e.g. built-in `default` running pentest without handoff to a pack that has act tools).  
- Mandatory Session-scoped filesystem migration in v1.  
- Subagent keep-alive redesign.  
- Standalone CLI resume composite strings (non-product Node path) unless later aligned deliberately.  
- HITL dual chrome shells ([#450](https://github.com/zangjiaao/my-ai-pen/issues/450)) — orthogonal presentation.

---

## Further Notes

- Builds on #354 (Session owns runtime) but focuses on **dialogue path pollution**, not dispose whitelist.  
- Spec precedence: `AGENTS.md` → `prd.md` → this Spec for continue turn-body rules when older resume helpers still describe instruction continuity via prose glue.  
- Living doc index: `docs/README.md`.
