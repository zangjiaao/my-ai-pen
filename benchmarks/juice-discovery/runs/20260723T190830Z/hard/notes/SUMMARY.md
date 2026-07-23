# Hard arm summary — authoritative core-only re-run

**Runtime:** `origin/main` / `runNode4Agent` — **pi-ai + pi-agent-core only** (no `pi-coding-agent`).  
**Graph:** `app_assessment_thin` Hard Graph  
**Target:** http://127.0.0.1:3010  
**Terminal:** `blocked`  
**Findings:** 0  
**Wall-clock:** ~204s  
**Node SHA:** `0efb262`

## Stages

| Stage | Outcome |
|-------|---------|
| init | blocked after retries — Feedback `structured_ok_false` / invalid or missing `result.json` |
| surface / class_probe / validate_book | not reached |

## Supersedes

Stamp `20260723T184122Z` ran on a **stale tree with pi-coding-agent** and is **non-authoritative**.

## Product observation (for scorecard A3 / deepen)

Hard Graph fail-closed at init handoff (`result.json` contract) on core-only Runtime — same class of gate failure as prior non-authoritative run, now valid as product-path evidence.
