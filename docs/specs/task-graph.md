# Pentest work modes: OMP, soft scenario Graph, Hard Graph × Pi

> Living companion to `docs/specs/harness.md` §6.  
> Calibrated: 2026-07-23 (Graph × Pi first cut + stage continuity A1/A4)

**Prompt single-source (soft scenario):** Graph captain/ledger/acceptance/packages live in runtime `formatGraphInjection` (`<work-mode>`). Pack `work.md` only points at that block for soft Graph detail — do not re-expand the same rules in work.md.

**Hard Graph:** product-owned runner (`hard-graph-*`); stage order and Feedback are **not** Main OMP scheduling. Soft scenario Graph is **not** Hard Graph DoD.

## One sentence

**Default / free OMP** — Main loop schedules itself (Default seat never Hard Graph).  
**Soft scenario Graph** — optional node menu + soft plan (Main may still schedule).  
**Hard Graph × Pi** — outer runner owns stages; pi runs inside stages; fail-closed gates.  
**Case** holds long-term shared state.

### Hard Graph stage continuity (A1 + A4)

Per-stage pi sessions still use isolated work dirs (`taskDir/hard-graph/<graphId>/stage-…`) for `result.json` / stage evidence audit. Continuity is explicit:

| Concern | Behavior |
|---------|----------|
| **Booking / proof (A1)** | After each stage, structured **candidates** upsert into **parent** lifecycle by `hard-stage:<stageId>` (same observation inject + candidate cache as soft subagent; retry replaces prior pack for that stage). Empty-candidate attempts do not wipe a prior pack. Next stage child is **seeded** from parent so book-only stages can `finding(confirm)` with matching `location` / `candidate_index` and verbatim `proof_excerpt`. Hallucinated proof still fails closed. |
| **Session jars (A4)** | Before a stage: seed `parent taskDir/session/` → stage workDir via session-seed helpers. After a stage: promote stage `session/` → parent (best-effort; child cookies win). |

Handoff JSON in the stage prompt remains informational; booking authority is lifecycle cache + groundable observations, not prompt-only tables. No expected-finding counts or answer keys in gates. Settlement still does not require N bookings.

## Modes

| Mode | How selected | Behavior |
|------|--------------|----------|
| **Default / free OMP** | No expert Hard Graph; Default seat or free expert | Pure OMP; Main may self-act; voluntary subagent |
| **Soft scenario Graph** | `graphId` app_assessment / redteam_deep without hard discipline | Node menu + RoE; **Main may act**; soft default_plan; **not** Hard Graph DoD |
| **Hard Graph × Pi** | `graphDiscipline=hard`, hard graph id (e.g. `app_assessment_thin`), or `NODE4_HARD_GRAPH=1` | Runner drives ordered stages; pi stage sessions; tool profiles; fail-closed Feedback; **Main is not the stage scheduler**; no outer-continue fight |

Lab-only Main act strip (soft path): `NODE4_GRAPH_MAIN_ACT=hard` or task `graphMainAct=delegate_only` — distinct from product Hard Graph runner.

UI default for casual work: **Default / free OMP**. Expert Hard Graph is explicit structured selection.

## Subagent + acceptance loop

```text
Main DISPATCH (goal + success_criteria)
  → Sub EVIDENCE (surfaces[] + candidates[] with proof_excerpt)
  → Main JUDGE (acceptance.ready_to_book | needs_more_evidence | surface_ledger)
       ├─ book finding(confirm) verbatim proof_excerpt
       └─ re-dispatch with gaps (max 2) then deadend
```

- No `command=`: LLM child (preferred for vuln claims).
- `command=`: shell only (weak for Graph claims).
- Main books; child does not. Child proofs inject into parent observations.
- Harness returns assistive `acceptance` on each subagent tool result (not a settlement gate).
- **Verbatim book:** `finding(confirm)` with matching `location` / `candidate_index` auto-uses candidate `proof_excerpt` (anti-paraphrase); proof may be omitted when matched.
- **Graph:** no `command=` shell subagents (lab: `NODE4_GRAPH_ALLOW_COMMAND_SUB=1`). Multi-package candidate cache; pathname-only match; book errors list candidate previews.

## Surface ledger (coverage truth)

- Path: `taskDir/surfaces/ledger.json` (`SurfaceLedgerStore`).
- **surface** packages must return `surfaces[]` (live recon locations). Empty → `package_gaps` / re-dispatch.
- Status: `open` → `in_probe` → `probed` | `booked` | `deadend` | `skipped_roe`.
- Candidate locations mark **probed**; `finding(confirm)` marks **booked**.
- **Graph `todo(done)`** blocked while open/in_probe remain unless `note=deadend|skipped_roe` or path already acted. No bare batch-flip.
- Settlement still does not require empty ledger; honesty is about todo green ≠ coverage.

## Parallel subagent batch (OMP-style, v1)

- Tool `subagent` accepts **flat** one package or **batch** `packages[]` + optional shared `context`.
- Batch runs with `mapWithConcurrencyLimit` — default concurrency **8** (`NODE4_SUBAGENT_CONCURRENCY`, clamp 1–16). Safety ceiling 32 packages (not a quality gate).
- Sync only: soft package failure → `results[i].ok=false`; siblings continue.
- **Path re-dispatch budget:** same pathname ≤ **2** dispatches/task.
- **Session seed + promote:** child jars seed from parent `session/`; after each package, child cookies **promote back to parent** (still useful when Main does not re-login; required under lab hard).
- **Worker keep-alive (OMP-style):** after LLM packages (incl. soft-fail/timeout), idle by **`agent_id`**. Default spawn **cold**. Warm only via `resume_agent_id` + **same-path affinity**. **Release:** active idle TTL (default **420s**), maxIdle LRU (8), maxPackages (4), `subagent(op=release)`, task-end `disposeAll`. List: `op=list`. Disable: `NODE4_SUBAGENT_IDLE=0`.
- **Salvage:** missing `result.json` → candidates from tool-output/facts when possible.
- Ledger/post-process mutex-serialized. Main still books.

## Non-goals

- Kill-chain as hard `force_order` state machine  
- Stage-named product experts (Recon/Exploiter/Validator seats)  
- Platform conversation Orchestrator  
- LangGraph / CrewAI as execution kernel  

## Pack files

- `experts/pentest/graphs/app_assessment.json`
- `experts/pentest/graphs/redteam_deep.json`

## DVWA three-way lab

```bash
cd node4
# Requires DVWA e.g. http://127.0.0.1:8080
bash scripts/bench-dvwa-work-modes.sh
# Or subset:
MODES="free soft" bash scripts/bench-dvwa-work-modes.sh
python3 scripts/score-dvwa-work-modes.py workspace/bench-dvwa-modes/<stamp>
```

Compare `compare.json`: booked findings, Main act vs subagent call mix.
