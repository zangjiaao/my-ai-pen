# Scorecard — Hard Graph Node4 vs Node5 (DVWA, offline)

> Filled post-#69 + surface value→location fix  
> Map: [#59](https://github.com/zangjiaao/my-ai-pen/issues/59) · Ticket: [#66](https://github.com/zangjiaao/my-ai-pen/issues/66)  
> **Do not** paste into agent prompts.

**Target:** DVWA

---

## 0. Red-line checks

| # | Check | Pass? | Notes |
|---|--------|-------|-------|
| R0 | Scorecard offline | **Y** | |
| R1 | No walkthrough answer keys in agent input | **Y** | |
| R2 | Hard = mature `hard_app_assessment` (not soft / Main-act strip) | **Y** | Template freeze text still says thin; run used Expert mature after #69 |
| R3 | Node5 lab CLI | **Y** | |
| R4 | Hard clean DVWA | **Y** | `dvwa-hvn5-hard` :8080 recreated before re-run |
| R5 | Node5 clean DVWA | **Y** | `dvwa-hvn5-node5` :8081 recreated before arm |
| R6 | Hard not blocked@init | **Y** | Prior stamp `20260724T020525Z` blocked@surface (value-shaped surfaces); fixed + re-run |

**Segment valid?** **Y** (authoritative stamp `20260724T021339Z`)

---

## 1. Segment meta

| Field | Value |
|-------|-------|
| Stamp | `runs/20260724T021339Z/dvwa/` |
| Hard target | `http://127.0.0.1:8080` |
| Node5 target | `http://127.0.0.1:8081` |
| Model | deepseek / deepseek-v4-flash both |
| Node SHA | `3e66b7b` (+ surface location alias fix in session) |
| Graphs | Hard mature `hard_app_assessment` · Node5 `app_assessment` |
| Wall | Hard ~**2741s (~46m)** · Node5 ~**2201s (~36m)** |

---

## 2. Arm A — Hard Graph Node4 (mature)

| Field | Value |
|-------|-------|
| Terminal | **completed** / hard_graph_completed |
| Booked findings | **18** |
| Stages | init→surface→auth_session→class_probe→authz_logic→component→validate_book **all passed** |
| Notes | After fix, surface accepted **24** locations; class_probe multi-class; validate_book booked SQLi/RCE/LFI/CSRF/config disclosure |

### Process / honesty (gist)

HP1–HP10: **Y** overall — mature path, evidence-backed bookings, no process collapse. Minor: a couple near-duplicate directory-listing bookings.

### Capability (distinct-ish)

| Class | Count gist |
|-------|------------|
| Injection / RCE / LFI | SQLi UNION + boolean + blind, command exec, LFI |
| Auth / session | session fixation, weak session ids, cookie flags, brute force, CSRF token reuse |
| CSRF | password-change CSRF |
| Exposure | config.bak credentials, setup.php, phpinfo, directory listing, missing headers |
| XSS / upload | not strongly in final booked set (component fan-out ran) |

---

## 3. Arm B — Node5 lab

| Field | Value |
|-------|-------|
| Terminal | exit 0 finalize |
| Booked findings | **16** |
| Stages | full plan through finalize |
| Packages | ssrf, auth-session, file-upload, xss, sql-injection, authz-logic |

### Process / honesty (gist)

NP1–NP10: **Y** overall. Residual structure soft-fails possible (same Node5 class as Juice).

### Capability (gist)

See findings under `node5/notes/SUMMARY.md` — expected DVWA class coverage (injection/XSS/upload/auth/exposure mix from Node5 packages).

---

## 4. Comparison (J1)

| Dimension | Hard | Node5 | Hard ≥ Node5? |
|-----------|------|-------|---------------|
| Process honesty / completion | full mature plan | full finalize | **Y/tie** |
| Evidence-backed count | **18** | **16** | **Y** |
| High-impact classes (SQLi/RCE/LFI) | strong | present | **Y/tie** |
| Auth/session depth | strong | present | **Y/tie** |
| Trust | usable | usable | — |

**Process collapsed on Hard?** **N**

---

## 5. Verdicts

| Item | Value |
|------|-------|
| Valid segment? | **Y** |
| F2 floor (Hard ≥1)? | **Y** |
| J1 Hard ≥ Node5? | **Y** |
| **DVWA P1 pass?** | **Y** |

**Freeform:** First DVWA Hard attempt blocked solely because agent used `{value,type}` surfaces and normalize required `location` — **not** agent skill. Fix (`value|href|endpoint` aliases) unblocked; re-run completed with critical impact findings. Combined with Juice P1 pass, **both-target P1** is met → unlocks [Task: X1 hard-delete node5](https://github.com/zangjiaao/my-ai-pen/issues/67).

---

## Artifacts

```text
benchmarks/hard-vs-node5/runs/20260724T021339Z/dvwa/
  scorecard.md
  hard/   (18 findings)
  node5/  (16 findings)
Invalid prior: runs/20260724T020525Z/dvwa/INVALID.md
```
