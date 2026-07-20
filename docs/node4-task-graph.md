# Pentest Free vs Graph work mode

> Living companion to `docs/node4-harness.md` §6.  
> Calibrated: 2026-07-20

## One sentence

**OMP** decides who schedules whom (Main loop + optional subagent).  
**Scenario Graph** (optional) supplies a professional node menu and soft plan skeleton.  
**Case** holds long-term shared state. No LangGraph second runtime.

## Modes

| Mode | How selected | Behavior |
|------|--------------|----------|
| **Free** (product default) | No graph / `free` | Pure OMP; Main may self-act; voluntary subagent |
| **Graph** (product = hard) | `app_assessment` or `redteam_deep` | Node menu + RoE; **Main act tools stripped**; dense act via subagent; Main books. Child proofs inject into parent observations for `finding(confirm)`. |

Lab-only soft Graph: `NODE4_GRAPH_MAIN_ACT=soft` (not a product UI mode).

UI default: **自由 OMP**.

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
- **Session seed + promote:** child jars seed from parent `session/`; after each package, child cookies **promote back to parent** (Graph hard Main cannot call session tools — otherwise seed always empty).
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
