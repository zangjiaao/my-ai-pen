# Scorecard — Hard Graph Node4 vs Node5 (Juice Shop, offline)

> Filled for post-#69 dual-arm segment  
> Map: [Wayfinder: Hard Node4 parity vs Node5 → delete Node5](https://github.com/zangjiaao/my-ai-pen/issues/59)  
> Ticket: [Task: Juice P1 parity campaign](https://github.com/zangjiaao/my-ai-pen/issues/65)  
> Spec context: [Spec #69 mature Hard](https://github.com/zangjiaao/my-ai-pen/issues/69)  
> **Do not** paste into agent prompts.

**Target:** OWASP Juice Shop

---

## 0. Red-line checks

| # | Check | Pass? | Notes |
|---|--------|-------|-------|
| R0 | Scorecard offline only | **Y** | |
| R1 | No challenge list as answer key | **Y** | |
| R2 | Hard = Hard Graph mature primary (`hard_app_assessment` → `graphs/hard/app_assessment.json`) — **not** thin, not soft | **Y** | Protocol text still says thin; this segment intentionally uses **Expert mature Hard** after #69 |
| R3 | Node5 lab CLI | **Y** | |
| R4 | Hard independent clean Juice | **Y** | `juice-hvn5-hard` :3010 fresh |
| R5 | Node5 independent clean Juice | **Y** | `juice-hvn5-node5` :3011 recreated before Node5 arm |
| R6 | Hard not blocked@init | **Y** | full mature plan completed |

**Segment valid?** **Y**

---

## 1. Segment meta

| Field | Value |
|-------|-------|
| Stamp / run id | `runs/20260724T003348Z/juice/` |
| Operator | agent session (post-#69) |
| Date (UTC) | 2026-07-24 |
| Target URL | Hard `http://127.0.0.1:3010` · Node5 `http://127.0.0.1:3011` |
| Hard instance | `juice-hvn5-hard` fresh docker |
| Node5 instance | `juice-hvn5-node5` recreated clean before arm |
| Node4 product SHA | `3e66b7b` (includes #69–#75 Hard maturity) |
| Node5 tree | same monorepo checkout |
| Model(s) | **deepseek / deepseek-v4-flash** both arms |
| Expert pack / graph ids | Hard: `hard_app_assessment` (mature) · Node5: `app_assessment` |
| Wall-clock | Hard ~**2200s (~37m)** · Node5 ~**2846s (~47m)** — both under ≤2h |

---

## 2. Arm A — Hard Graph Node4 (mature)

### 2.1 Run meta

| Field | Value |
|-------|-------|
| Wall-clock | ~2200s (overrun? N) |
| Terminal | `completed` / `hard_graph_completed` |
| Artifact root | `runs/20260724T003348Z/juice/hard/` |
| Booked findings | **18** (raw; some near-duplicate titles/locations) |
| Stages | init → surface → auth_session → class_probe → authz_logic → component → validate_book — all **passed** |
| Empty ledger / proof-chain break? | **N** — class_probe produced **38** candidates with proof_excerpt; validate_book booked 18 |

### 2.2 Process / honesty

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| HP1 | Hard Graph mature path | **Y** | fan-out subagents observed in class_probe/component |
| HP2 | Hypothesis-driven | **Y** | multi-class candidates |
| HP3 | Surface breadth | **Y/partial** | rich surfaces; some classes only in candidates |
| HP4 | Within-class depth | **partial** | multi-location exposure; some dups at book |
| HP5 | Evidence-backed bookings | **Y** | 18 |
| HP6 | Cross-stage handoff usable | **Y** | #70 book-from-handoff fixed (was 11→2 thrash) |
| HP7 | RoE | **Y** | |
| HP8 | Honest counts | **Y/partial** | a few duplicate bookings same issue |
| HP9 | Premature stop | **N** | full stage set |
| HP10 | Terminal honest | **Y** | |

### 2.3 Capability categories (distinct-ish counts)

| Class (include) | Distinct count | Notes |
|-----------------|----------------|-------|
| Auth / session integrity | **6+** | mass assignment admin, captcha, security Q, password reset/change, JWT hash/no-exp, no logout |
| Injection | **3+** | SQLi login, SQLi search, null-byte ftp |
| Access control | **1–2** | users API exposure / challenges (weaker dual-actor narrative in booked set) |
| XSS / client injection | **0 booked** | candidates claimed XSS in class_probe; not in final 18 |
| Sensitive exposure / misconfig | **2+** | /ftp listing, hash exposure paths |
| Business logic / anti-automation | **0–1** | |
| SSRF / CSRF / server-side request | **0 booked** | change-password GET is CSRF-adjacent |
| Upload / component / RCE-class | **0 booked** | component stage ran |
| Registration / input validation | **1** | mass assignment reg |

### 2.4 Known product limits

| ID | Limit | Observed? | Notes |
|----|-------|-----------|-------|
| Thin stages | N/A mature 7-stage | N | mature used |
| A2 | fan-out | **fan-out used** | subagent packages in class_probe |
| Coverage Feedback | partial | partial | process metrics present in runner; offline scorecard not Node5 coverage ledger |

---

## 3. Arm B — Node5 lab

### 3.1 Run meta

| Field | Value |
|-------|-------|
| Wall-clock | ~2846s (overrun? N) |
| Terminal | exit 0 finalize complete |
| Artifact root | `runs/20260724T003348Z/juice/node5/` |
| Findings | **15** |
| Stages | full plan through finalize |
| State/summary readable? | **Y** |

### 3.2 Process / honesty

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| NP1 | Node5 lab path | **Y** | |
| NP2 | Hypothesis-driven | **Y** | |
| NP3 | Surface breadth | **Y** | 62 surfaces |
| NP4 | Within-class depth | **Y/partial** | |
| NP5 | Evidence-backed | **Y** | 15 |
| NP6 | State usable | **Y** | |
| NP7 | RoE | **Y** | |
| NP8 | Honest counts | **Y** | |
| NP9 | Premature stop | **N** | |
| NP10 | Terminal honest | **Y** | structure_fail_n=5 with retries; coverage attempt_rate≈0.64 |

### 3.3 Capability categories

| Class (include) | Distinct count | Notes |
|-----------------|----------------|-------|
| Auth / session integrity | **5+** | mass assignment, JWT alg:none/HS256 confusion, change-password takeover, 2FA/TOTP, security Q |
| Injection | **1** | SQLi search (strong DB extract narrative) |
| Access control | **4+** | BFLA products, basket IDOR, order history, users BAC |
| XSS | **0 booked** | |
| Sensitive exposure | **2+** | encryptionkeys, memories hashes |
| Business logic | **0–1** | |
| SSRF | **1** | profile image URL |
| Upload / RCE | **0 booked** | |
| Registration | **1** | mass assignment |

---

## 4. Comparison (J1)

| Dimension | Hard (A) | Node5 (B) | Hard ≥ Node5? | Notes |
|-----------|----------|-----------|---------------|-------|
| Process honesty | mature stages + fan-out + book handoff | complete + coverage honesty | **Y** | Hard no longer thrash-collapsed |
| Stage completion | all passed | all done | **Y/tie** | |
| Evidence-backed finding count | **18** raw | **15** | **Y** | Hard has near-dups; unique ~14–16 |
| Classes with count ≥ 1 | ~5–6 | ~6–7 | **partial** | Node5 leads JWT alg + SSRF + 2FA + IDOR basket |
| Classes with count ≥ 2 | several auth/injection | several authz | **partial** | different density |
| Surface / depth narrative | strong recon + 38 class_probe cands | strong fan-out packages | **tie** | |
| Trust for real app_assessment | **usable** | **usable** | — | both lab-grade |

**Process collapsed on Hard?** **N**

---

## 5. Verdicts

### 5.1 Valid segment

| Item | Value |
|------|-------|
| Both arms complete? | **Y** |
| Scorecard honestly filled? | **Y** |
| R0–R6 all Y? | **Y** |
| **Valid segment?** | **Y** |

### 5.2 P1 parity (this target only)

| Item | Value |
|------|-------|
| Valid segment? | **Y** |
| F2 discovery floor met? | **Y** (Hard 18 ≥ 1) |
| J1 human total: Hard ≥ Node5 on M1 package? | **Y (narrow)** — process fixed; finding volume ≥ Node5; Node5 still wins some high-value classes (JWT alg:none, SSRF, 2FA, basket IDOR) |
| **Juice P1 pass?** | **Y** |

If gaps for next Hard optimization (optional, not blocking this pass):
1. Book JWT alg:none / key-confusion when proven (Node5 strength)
2. Book SSRF profile image + 2FA secret surfaces when candidates exist
3. Deduplicate validate_book confirmations (same location booked twice)
4. Convert XSS candidates that class_probe claimed into bookable findings when proof holds

**Freeform notes:**  
Post-#69 mature Hard is a **different product** than the thin 2-finding thrash run. Fan-out + book-from-handoff delivers multi-stage candidates and 18 bookings. Node5 remains a strong reference on authz/JWT/SSRF/2FA. For map O1, Juice P1 is judged **pass**; DVWA campaign still required before X1 delete Node5.

---

## 6. Artifact layout

```text
benchmarks/hard-vs-node5/runs/20260724T003348Z/juice/
  scorecard.md
  hard/  (18 findings, SUMMARY, standalone.log, workspace, hard-graph-run-result.json)
  node5/ (15 findings, SUMMARY, work/, node5.log)
```
