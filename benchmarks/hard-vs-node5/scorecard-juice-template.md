# Scorecard — Hard Graph Node4 vs Node5 (Juice Shop, offline)

> **FROZEN** for Hard-vs-Node5 P1  
> Map: [Wayfinder: Hard Node4 parity vs Node5 → delete Node5](https://github.com/zangjiaao/my-ai-pen/issues/59)  
> Freeze ticket: [Grilling: freeze Hard vs Node5 P1 scorecard (M1)](https://github.com/zangjiaao/my-ai-pen/issues/60)  
> **Do not** paste this file into the agent prompt. Scoring is offline.

**Target:** OWASP Juice Shop (default `http://127.0.0.1:3000` unless noted).

---

## Freeze contract (read first)

| Lock | Decision |
|------|----------|
| **Arms** | **Hard** = product Hard Graph thin (`app_assessment_thin`). **Node5** = lab CLI (`python -m node5 run`, pack `app_assessment`). **No Soft section.** |
| **Structure** | Process/honesty (P1–P10) per arm **+** capability category distinct counts (9 classes) **+** comparison **+** P1 verdict. |
| **Category density** | Per class: **count of distinct evidence-backed hits** (different location/object = separate count). Notes cite **this run’s** findings only. |
| **Not a write-up full cover** | Taxonomy source only. Exclude CTF meta / easter / Web3 / character-lore / gimmicks from capability scoring. No challenge list as answer key. |
| **Judgment (J1)** | Dimensional compare Hard vs Node5 + **human** total “Hard ≥ Node5”. **Not** automatic `sum(counts) ≥`. |
| **Floor (F2)** | Before total: valid segment (R0–R6) + process not collapsed + **Hard ≥1 evidence-backed booked finding** — unless Node5 is also 0 and both are **honest empty** with reason. Hard empty + Node5 has findings → **P1 fail**. |
| **Valid segment** | Both arms complete + card honestly filled + **R0–R6 = Y**. Distinct from map-close (X1 delete Node5). |
| **Evidence on disk** | Per arm: `findings/` + short `notes/SUMMARY.md` (+ optional `meta.json`). Large sessions: summarize or gitignore; pointer OK. |
| **Instance hygiene** | **Mandatory:** each arm on an **independent clean** Juice instance. Shared/dirty → segment **invalid**. |

---

## 0. Red-line checks (all must be Y for a valid segment)

| # | Check | Pass? | Notes |
|---|--------|-------|-------|
| R0 | Scorecard and write-up spoilers stayed **offline** (not in prompts / Hard Graph gates / runtime checklists) | Y/N | |
| R1 | No Juice challenge list, payload table, or official scoreboard used as agent-facing answer key | Y/N | |
| R2 | Hard arm is **Hard Graph thin** (`app_assessment_thin`) — not soft, not lab Main-act strip | Y/N | |
| R3 | Node5 arm is **Node5 lab CLI** — not claimed as product Node / platform citizen | Y/N | |
| R4 | **Hard** used independent **clean** Juice instance | Y/N | |
| R5 | **Node5** used independent **clean** Juice instance (not Hard’s dirty leftover) | Y/N | |
| R6 | Hard **not** blocked@init / false-death before discovery stages (map R1) | Y/N | |

**Segment valid?** (R0–R6 all Y + both arms complete + card filled) → Y / N

---

## 1. Segment meta

| Field | Value |
|-------|-------|
| Stamp / run id | `runs/<stamp>/juice/` → ________ |
| Operator | ________ |
| Date (UTC) | ________ |
| Target URL | default `http://127.0.0.1:3000` (override: ________) |
| Hard instance id / how cleaned | ________ |
| Node5 instance id / how cleaned | ________ |
| Node4 product SHA (Hard) | ________ |
| Node5 tree SHA / version note | ________ |
| Model(s) (same tier both arms) | ________ |
| Expert pack / graph ids | Hard: `app_assessment_thin` · Node5: `app_assessment` |
| Wall-clock budget note | suggest ≤2h/arm; overrun allowed if noted |

---

## 2. Arm A — Hard Graph Node4 (thin)

**Path:** Expert Hard Graph thin — standalone `--graph-id app_assessment_thin` (or product hard equivalent).  
**Not** `bench-dvwa-work-modes.sh` mode `hard` (Main-act strip).

### 2.1 Run meta

| Field | Value |
|-------|-------|
| Wall-clock | ________ (overrun? Y/N) |
| Terminal / harness status | ________ |
| Artifact root | `runs/<stamp>/juice/hard/` |
| Booked findings (evidence-backed count) | ________ |
| Stages reached (init → …) | ________ |
| Empty ledger / proof-chain break? | Y/N — ________ |

### 2.2 Process / honesty

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| HP1 | Stayed on **Hard Graph thin** path | Y/N | |
| HP2 | Hypothesis-driven; not only one easy win then stop | Y/N/partial | |
| HP3 | **Surface breadth:** kept probing while concrete untested surfaces remained (or honest budget stop) | Y/N/partial | |
| HP4 | **Within-class depth:** one location ≠ class done without checking other plausible locations (or noted why not) | Y/N/partial/na | |
| HP5 | Evidence-backed booking(s) **or** explicit honest empty with reason | Y/N | |
| HP6 | Cross-stage booking/proof usable (no whole-run empty from broken handoff) | Y/N/na | |
| HP7 | RoE app_assessment (no off-box post-ex) | Y/N | |
| HP8 | Honest counts: no invented CVEs / no challenge-flag fiction | Y/N | |
| HP9 | Premature stop with time left? | Y/N/unclear | |
| HP10 | Fail-closed / terminal honest (blocked vs completed matches evidence) | Y/N | |

### 2.3 Capability categories — distinct evidence counts

For each **include** class, count **distinct** evidence-backed hits in **this arm’s** findings.  
`0` = none · `1` = single location · `≥2` = multi-location density signal.

| Class (include) | Distinct count | Notes |
|-----------------|----------------|-------|
| Auth / session integrity | | |
| Injection (SQL/NoSQL/template/…) | | |
| Access control (IDOR / priv) | | |
| XSS / client injection | | |
| Sensitive exposure / misconfig | | |
| Business logic / anti-automation | | |
| SSRF / CSRF / server-side request | | |
| Upload / component / RCE-class | | |
| Registration / input validation | | |

**Exclude from capability scoring** (if only these appeared, say so): scoreboard/CTF meta, easter/stego/obscurity, Web3/NFT, pure character-lore logins, UI gimmicks.

### 2.4 Known product limits (observe only — not automatic P1 fail)

| ID | Limit | Observed? | Notes |
|----|-------|-----------|-------|
| Thin stages | 4-stage thin vs longer Node5 plan | Y/N/unclear | |
| A2 | No package fan-out inside Hard stages | Y/N/unclear | |
| Coverage Feedback | Hard lacks Node5-class coverage loop | Y/N/unclear | |
| Other | ________ | | |

---

## 3. Arm B — Node5 lab

**Path:** Node5 CLI lab — e.g. `python -m node5 run --target <url> --graph-id app_assessment …`  
See research: `docs/wayfinder/node5-lab-invocation-juice-dvwa.md`.

### 3.1 Run meta

| Field | Value |
|-------|-------|
| Wall-clock | ________ (overrun? Y/N) |
| Terminal / status | ________ |
| Artifact root | `runs/<stamp>/juice/node5/` |
| Findings (evidence-backed count) | ________ |
| Stages / process_metrics gist | ________ |
| State/summary readable? | Y/N — ________ |

### 3.2 Process / honesty

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| NP1 | Stayed on **Node5 lab** `app_assessment` path | Y/N | |
| NP2 | Hypothesis-driven; not only one easy win then stop | Y/N/partial | |
| NP3 | Surface breadth (or honest budget stop) | Y/N/partial | |
| NP4 | Within-class depth | Y/N/partial/na | |
| NP5 | Evidence-backed findings **or** honest empty with reason | Y/N | |
| NP6 | State / findings / summary usable for offline review | Y/N/na | |
| NP7 | RoE app_assessment | Y/N | |
| NP8 | Honest counts | Y/N | |
| NP9 | Premature stop with time left? | Y/N/unclear | |
| NP10 | Fail-closed / terminal honest | Y/N | |

### 3.3 Capability categories — distinct counts (same 9 classes)

| Class (include) | Distinct count | Notes |
|-----------------|----------------|-------|
| Auth / session integrity | | |
| Injection | | |
| Access control | | |
| XSS / client injection | | |
| Sensitive exposure / misconfig | | |
| Business logic / anti-automation | | |
| SSRF / CSRF / server-side request | | |
| Upload / component / RCE-class | | |
| Registration / input validation | | |

---

## 4. Comparison (offline, J1)

| Dimension | Hard (A) | Node5 (B) | Hard ≥ Node5? | Notes |
|-----------|----------|-----------|---------------|-------|
| Process honesty (P\* gist) | | | Y/N/partial | |
| Stage completion / terminal honesty | | | Y/N/partial | |
| Evidence-backed finding count | | | Y/N/na | |
| Classes with count ≥ 1 | | | Y/N/partial | |
| Classes with count ≥ 2 (multi-location) | | | Y/N/partial | |
| Surface / depth narrative | | | Y/N/partial | |
| Trust for real app_assessment? | usable / fragile / fail | usable / fragile / fail | — | |

**Process collapsed on Hard?** (critical process fails: wrong path, broken booking chain, wholesale fiction) → Y / N  
If Y → **P1 fail** regardless of counts.

---

## 5. Verdicts

### 5.1 Valid segment

| Item | Value |
|------|-------|
| Both arms complete? | Y/N |
| Scorecard honestly filled? | Y/N |
| R0–R6 all Y? | Y/N |
| **Valid segment?** | Y/N |

### 5.2 P1 parity (this target only)

| Item | Value |
|------|-------|
| Valid segment? | Y/N |
| F2 discovery floor met? (Hard ≥1 evidence finding, or both honest empty with Node5=0) | Y/N |
| J1 human total: **Hard ≥ Node5** on M1 package? | Y/N |
| **Juice P1 pass?** | Y/N |

If P1 fail: list top gaps for Hard optimization (do **not** close map; F2 = keep looping):  
1.  
2.  
3.  

**Freeform notes:**  

---

## 6. Artifact layout (frozen) — `runs/<stamp>/juice/`

```text
benchmarks/hard-vs-node5/runs/<stamp>/juice/
  scorecard.md              # filled copy of this template
  hard/
    notes/SUMMARY.md
    findings/
    meta.json               # optional
  node5/
    notes/SUMMARY.md
    findings/
    meta.json               # optional
```

| Rule | |
|------|--|
| Copy | Durable findings + short notes into this tree |
| Large sessions | Summarize or gitignore; path pointer OK |
| Invalid | Shared dirty Juice across arms |
| Not here | Soft arm artifacts (optional elsewhere; not P1) |
