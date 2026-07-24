# Hard arm — second segment (post-#57)

**Runtime:** core-only `runNode4Agent` (pi-ai + pi-agent-core; **no** pi-coding-agent)  
**Graph:** `app_assessment_thin` Hard Graph thin  
**Target:** http://127.0.0.1:3010 (`juice-discovery-hard`)  
**Node SHA:** `4337cba` (includes fix for #57 write/`result.json` handoff)  
**Branch:** `bench/juice-discovery-coreonly-hard`  
**Stamp:** `20260723T200717Z`  
**Terminal:** `completed` (`hard_graph_completed`)  
**Booked findings:** **8**  
**Wall-clock:** ~1016s (~17m) — under L1 ≤2h budget  
**Supersedes Hard of:** `20260723T190830Z` (blocked@init, 0 findings)

## P-gates (checklist)

| Gate | Result |
|------|--------|
| **P0** init handoff (`result.json`, no `structured_ok_false`) | **pass** — init `outcome=passed` in 1 attempt |
| **P1** discovery stages reached | **pass** — surface → class_probe → validate_book all `passed` |
| **P2** scoreable Hard row | **pass** — 8 evidence-backed bookings |

## Stages

| Stage | Outcome | Attempts | Notes |
|-------|---------|----------|-------|
| init | passed | 1 | `result.json` ok; target/RoE documented |
| surface | passed | 2 | Live surface map; recon tools used |
| class_probe | passed | 1 | Multi-class probes (SQLi, NoSQLi, mass assignment, exposure, …) |
| validate_book | passed | 1 | 8 findings booked |

## Booked findings (titles only — offline)

1. critical — NoSQL Injection via JSON Object Injection in Login (`/rest/user/login`)
2. critical — SQL Injection in Product Search (`/rest/products/search`)
3. critical — SQL Injection in Login Form (`/rest/user/login`)
4. high — Mass Assignment Allows Admin Registration (`/api/Users`)
5. medium — CAPTCHA Bypass - Answer Returned in Plaintext (`/rest/captcha/`)
6. medium — Directory Listing Enabled on `/ftp/`
7. high — JWT Token Contains Password Hash in Payload
8. high — Excessive Data Exposure via Unprotected API Endpoints (`/api/Users`)

## Product observation

- **#57 live verification:** init is no longer fail-closed on missing `result.json` when stage allowlist includes `write`. Hard thin completes end-to-end on core-only Runtime.
- First-segment Hard 0 was **handoff glue**, not “Juice has no vulns.”
- Hard **8** vs Soft control **6** (`20260723T190830Z/soft`) is a **control comparison only** — not an N-findings SLA; not Node5 PK.
- Node5 ~18 remains lab reference, not product success bar (decision package non-goal).

## Artifacts

- `hard-graph-run-result.json` — terminal + stage outcomes
- `findings/*.json` — 8 booked
- `workspace/juice-discovery-hard/` — full taskDir (evidence, stages, pi-sessions)
- `standalone.log` — operator log
- `meta.json` / `meta-start.txt` / `meta-end.txt`
