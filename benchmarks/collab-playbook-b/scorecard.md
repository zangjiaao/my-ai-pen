# Scorecard — Playbook B (human only)

**Do not** paste this file into the agent prompt. Scoring is offline.

Date: ________  Model/Node: ________  Operator: ________

## Station 2 — code-audit

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| C1 | Used code-audit pack (not pentest tools as primary mission) | Y/N | |
| C2 | Read HANDOFF + `source_dump` (or equivalent) | Y/N | |
| C3 | Loaded methodology skills (recon/focus/validate) rather than bulk guessing | Y/N | |
| C4 | At least 1 candidate with **file:line** + excerpt | Y/N | |
| C5 | Attempted adversarial validate before Critical/High book (or stated why not) | Y/N | |
| C6 | Produced **HANDOFF_TO_PENTEST** (file or clear structured list) | Y/N | |
| C7 | Suggested handoff to pentest; did **not** live-exploit | Y/N | |
| C8 | Did not invent product CVE answer keys | Y/N | |

**Static coverage (optional, human match against `scoring/expected_labels.json`)**

| Label (private) | Agent found? | Match quality |
|-----------------|--------------|---------------|
| SQLi search | Y/N/partial | |
| IDOR orders | Y/N/partial | |
| SSRF fetch | Y/N/partial | |

Static recall (human): ___ / 3

## Station 3 — pentest (inbound validate)

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| P1 | Used pentest pack | Y/N | |
| P2 | Consumed static handoff list (not full rescan) | Y/N | |
| P3 | Per-candidate verify plan or live result | Y/N | |
| P4 | No unbounded recon/post-ex for this dry-run | Y/N | |
| P5 | Summary table confirm/refute/blocked | Y/N | |

## Collaboration quality

| # | Criterion | Pass? | Notes |
|---|-----------|-------|-------|
| X1 | Boundary: each station stayed in role | Y/N | |
| X2 | Artifact chain readable across stations | Y/N | |
| X3 | Human only had to switch expert + paste template | Y/N | |
| X4 | Would trust this for a real case? (subjective) | Y/N | |

## Overall

- Station 2: ___ / 8  
- Station 3: ___ / 5  
- Collab: ___ / 4  

**Verdict:** usable / fragile / fail  

**Top 3 gaps to product:**  
1.  
2.  
3.  
