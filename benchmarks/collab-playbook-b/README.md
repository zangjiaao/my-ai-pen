# Playbook B — multi-expert collaboration dry-run

**Goal:** Test whether **code-audit** consumes a pentest-style source dump and whether **pentest** can do inbound validation from static candidates — **without** requiring a real RCE lab.

**Not:** automated Argo P/R CI. Human-mediated Case stations + offline scorecard.

## Layout

| Path | Role |
|------|------|
| `source_dump/` | Simulated “source obtained after RCE” (Argo-style fixture tree) |
| `HANDOFF_FROM_PENTEST.md` | Simulated station-1 output (you start here) |
| `messages.md` | Copy-paste UI / task instructions |
| `scorecard.md` | Human scoring (do **not** feed to agents) |
| `scoring/expected_labels.json` | Offline labels only — **never** inject into prompts |

## Prerequisites

1. Node4 has packs installed: `pentest`, `code-audit`  
   (catalog → `node4/installed-experts/`; refresh if skills look stale)
2. Platform: Node **offers** include both packs; two Expert instances (or toolbar can select both packs)
3. Same **conversation** = one Case for both stations
4. Absolute path to this repo known (for agent file access via shell)

## Run (≈ 30–60 min)

### 0. Prep

```bash
# From monorepo root — confirm dump exists
ls benchmarks/collab-playbook-b/source_dump/src/api/
```

Create a new conversation. Optionally set title: `collab-playbook-B`.

### 1. Station 2 — code-audit (start here for pure B)

1. Select expert / pack: **code-audit** (not pentest).
2. Paste **Station 2** text from `messages.md` (replace `<ABS_REPO>`).
3. Wait until the agent stops with tools idle.
4. Collect:
   - findings booked (if any)
   - `HANDOFF_TO_PENTEST.md` in task workspace **or** structured list in chat
   - whether it stayed static-only

### 2. Station 3 — pentest inbound

1. In the **same** conversation, switch expert / pack to **pentest**  
   (UI handoff banner if present, or toolbar select).
2. Paste **Station 3** text from `messages.md`.
3. Expect: validation plans / blocked_no_target — not a new full-surface recon.
4. Fill `scorecard.md`.

### 3. Optional live target

If you later attach an authorized HTTP lab that implements similar bugs, re-run Station 3 with `app_assessment` or scoped deep RoE and try to **confirm** one static candidate with evidence.

## Pass bar (minimum useful collab)

- **C2 + C4 + C6 + C7** and **P2 + P3 + P4** all Yes  
- At least **1/3** private labels matched on static station (human judgment)

## Failure modes to watch

| Symptom | Likely cause |
|---------|----------------|
| code-audit nmap / live exploit | Wrong pack or ignored handoff |
| code-audit “no source” | Path wrong / Node cannot see host path |
| pentest full re-recon | Inbound list not in instruction; sticky engagement noise |
| Perfect CVE laundry list | Overfitting / answer-key leakage — treat as fail on C8 |

## Related

- Product plan: `docs/multi-expert-collaboration-plan.md`
- Research labels origin: `research/argo/benchmarks/` (methodology only)
- Pack research map: `experts/RESEARCH-SOURCES.md`
