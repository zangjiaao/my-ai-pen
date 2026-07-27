# Dual-target lab scorecards — process + discovery (#164)

**Issue:** [#164](https://github.com/zangjiaao/my-ai-pen/issues/164)  
**Parent Spec:** [#139](https://github.com/zangjiaao/my-ai-pen/issues/139)  
**Primary Product seam:** Expert Graph `app_assessment` taskDir Product state (not chat prose).

Offline only. No agent-facing spoilers, no expected vulnerability count gates, no DVWA/Juice answer keys in product code.

---

## Invocation

### 1. Clean targets (independent instances)

```bash
# Example dual clean targets (adjust ports as needed)
docker rm -f lab-score-dvwa lab-score-juice 2>/dev/null || true
docker run -d --name lab-score-dvwa -p 8083:80 vulnerables/web-dvwa:latest
docker run -d --name lab-score-juice -p 3012:3000 bkimminich/juice-shop:latest
# wait for HTTP 200/302 on both
```

### 2. Expert Graph arms (Node4 standalone)

```bash
cd node4
set -a; source .env; set +a
npx tsx src/expert-cli.ts install pentest

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$PWD/workspace/lab-score/$STAMP"
mkdir -p "$OUT"/{dvwa,juice,logs}

# Instruction files: authorized lab only — no challenge lists / scoreboards as agent success metric
npx tsx src/standalone.ts \
  --task-id "score-dvwa-${STAMP}" \
  --engagement pentest \
  --graph-id app_assessment \
  --target "http://127.0.0.1:8083" \
  --scope "127.0.0.1,localhost,host.docker.internal" \
  --instruction-file "$OUT/dvwa/instruction.txt" \
  --output "$OUT/dvwa" \
  >"$OUT/logs/dvwa.log" 2>&1

npx tsx src/standalone.ts \
  --task-id "score-juice-${STAMP}" \
  --engagement pentest \
  --graph-id app_assessment \
  --target "http://127.0.0.1:3012" \
  --scope "127.0.0.1,localhost,host.docker.internal" \
  --instruction-file "$OUT/juice/instruction.txt" \
  --output "$OUT/juice" \
  >"$OUT/logs/juice.log" 2>&1
```

### 3. Offline score (script + human discovery notes)

```bash
# Single taskDir
python3 node4/scripts/score-process-discovery-139.py \
  node4/workspace/lab-161-dvwa/20260727-184104/lab161-dvwa-20260727-184104 \
  --label DVWA

# Dual stamp (finds engagement-closeout.json under tree)
python3 node4/scripts/score-process-discovery-139.py \
  --dual-root node4/workspace/lab-139-dual/20260727-133709
```

Artifact required for close-out checks: `taskDir/hard-graph/engagement-closeout.json` (NC-Closeout / #163).

---

## Scorecard dimensions

| Area | Script | Human offline |
|------|--------|----------------|
| Close-out present + required fields | yes | — |
| Terminal + stages | yes | — |
| process_complete honesty (blocked ⇒ false) | yes | — |
| residual_class when blocked + unbooked | yes | — |
| L0/L1 feedback gist | yes | — |
| Severity not all-medium collapse | yes | — |
| Booked findings have severity | yes | — |
| Discovery multi-class / non-menu bias | placeholder | **required** |
| Priors re-verify (when case seeded) | prior_n | re-verify narrative |

Discovery is **never** an expected-count gate.

---

## Lab evidence used for #164 acceptance (2026-07-27)

| Arm | Stamp | terminal | process (script) | booked | notes |
|-----|-------|----------|------------------|--------|-------|
| **DVWA (post-#161)** | `lab-161-dvwa/20260727-184104` | completed | 9/9 → extended checks | **10** | validate_book executed; multi-severity |
| **Juice (tip dual-arm)** | `lab-139-dual/20260727-133709` juice | blocked | 9/9 | **15** | honesty path + booking tail; process_complete=false |
| **DVWA (tip dual-arm, pre-#161)** | same dual stamp dvwa | completed | 9/9 | **0** | historical empty-book; superseded by post-#161 re-run |

Reports:  
- `node4/workspace/lab-161-dvwa/20260727-184104/logs/dvwa-report.md`  
- `node4/workspace/lab-139-dual/20260727-133709/logs/{juice,dvwa,dual-arm}-*.md`

---

## Living links

- Score script: `node4/scripts/score-process-discovery-139.py`
- Close-out contract: `docs/specs/task-graph.md` (Engagement close-out row)
- Graph definition: `experts/pentest/graphs/hard/app_assessment.json`
