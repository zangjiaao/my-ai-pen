# Protocol — Hard Graph Node4 vs Node5 (Q1 minimal)

> **FROZEN**  
> Map: [Wayfinder: Hard Node4 parity vs Node5 → delete Node5](https://github.com/zangjiaao/my-ai-pen/issues/59)  
> Freeze ticket: [Grilling: freeze Hard vs Node5 comparison protocol (Q1)](https://github.com/zangjiaao/my-ai-pen/issues/61)  
> Scorecard freeze: [Grilling: freeze Hard vs Node5 P1 scorecard (M1)](https://github.com/zangjiaao/my-ai-pen/issues/60)

**Do not** paste this file into agent prompts. Lab ops + offline scoring only.

---

## 1. Purpose

Run **comparable** lab pairs: product **Hard Graph Node4 thin** vs **Node5 lab CLI**, score offline with the frozen scorecards, until **P1 pass** on Juice then DVWA (map O1). Optimize **only Hard** between failed rounds (map F2).

This protocol does **not** close the map — map close is **X1 delete `node5/`** after both targets P1-pass.

---

## 2. Freeze table (operator checklist)

| Cell | Lock | Value |
|------|------|--------|
| **Model (M1)** | Same env string both arms | `PI_MODEL_PROVIDER` + `PI_MODEL` identical for Hard and Node5 (Node5 also reads `NODE5_*` / shared dotenv — must resolve to the **same** provider/id). Record actual values on scorecard meta. Change model → both arms + new stamp. |
| **Targets (T1)** | Dual clean instances | **Juice:** Hard and Node5 each get an **independent clean** Juice (e.g. ports `3010` / `3011` dedicated containers — do not share dirty DB). **DVWA:** same rule (two instances or full reset between arms; default compose often `8080` — provision a second port or recreate). Record **actual URLs** on scorecard. |
| **Default URL hints** | Not mandatory if dual ports differ | Juice family default in research: `http://127.0.0.1:3000`; dual-arm lab often `3010`/`3011`. DVWA: `http://127.0.0.1:8080` (+ second instance). |
| **Campaign order (S1 / O1)** | Serial | **Juice campaign first** (until Juice P1 pass), **then DVWA**. |
| **Arm order (S1)** | Per target | **Hard → Node5** (not parallel on same instance). |
| **Wall-clock (S1)** | Record always | Suggest **≤2h per arm**; overrun allowed if noted on scorecard. |
| **RoE** | app_assessment | In-scope assessment only; **no** off-box post-exploitation. Scope host: `127.0.0.1` / `localhost` + documented ports. |
| **Instruction parity** | Same intent | Same target URL intent, RoE, and prohibitions both arms. **No** scorecard text, write-ups, challenge lists, payload tables, or official scoreboards in agent-facing input. |
| **Hard path** | Product Hard thin | `app_assessment_thin` / Hard Graph discipline — **not** soft `app_assessment`, **not** lab Main-act strip (`NODE4_GRAPH_MAIN_ACT=hard` / bench “hard”). |
| **Node5 path** | Lab CLI | `python -m node5 run --target <url> --graph-id app_assessment …` — **not** product Node / platform citizen. See `docs/wayfinder/node5-lab-invocation-juice-dvwa.md`. |
| **Soft** | Out of this protocol | Optional elsewhere (S1); **not** required for P1; **not** on scorecard. |
| **Artifacts** | Scorecard layout | `benchmarks/hard-vs-node5/runs/<stamp>/{juice\|dvwa}/{hard\|node5}/` + filled `scorecard.md`. Templates: `scorecard-juice-template.md`, `scorecard-dvwa-template.md`. |
| **Scoring** | Offline only | Human fills scorecard; J1 + F2 + R0–R6 — see templates. |

---

## 3. Invocation pointers (not full re-research)

### 3.1 Hard Graph Node4 thin

Primary reference: `docs/wayfinder/hard-soft-juice-arm-invocation.md` (Hard primary section).

Typical shape (adjust paths/env to your lab):

```bash
# Ensure pentest pack installed on Node4; model env set (PI_MODEL_*).
# Prefer standalone with explicit hard thin graph — do NOT leave NODE4_HARD_GRAPH=1
# on a process that will later run non-hard work.

# Example pattern (verify flags against current node4 CLI):
# node4 standalone / tsx … --graph-id app_assessment_thin \
#   --target http://127.0.0.1:3010 \
#   --task-id "hvn5-juice-hard-<stamp>" \
#   --output <workspace>
```

Harvest into `runs/<stamp>/juice/hard/` (or `dvwa/hard/`): findings, short `notes/SUMMARY.md`, optional `meta.json` (SHA, graph id, terminal, wall-clock, model).

### 3.2 Node5 lab

Primary reference: `docs/wayfinder/node5-lab-invocation-juice-dvwa.md` (ticket #62).

```bash
cd node5
# editable install + same PI_MODEL_* / dotenv as Node4
python -m node5 run \
  --target http://127.0.0.1:3011 \
  --graph-id app_assessment \
  --work-dir <work> \
  --notes "hvn5-juice-node5-<stamp>"
```

Harvest into `runs/<stamp>/juice/node5/`: copy or pointer to `findings.json` / findings dir, `state.json`, `summary.json`, `run_meta.json`, short `notes/SUMMARY.md`.

**Never 1:1** with Hard layout (ADK flat work-dir vs `hard-graph/`) — scorecard compares capability/process, not path isomorphism.

### 3.3 Instance hygiene (T1 example — Juice)

Adapt from `benchmarks/juice-discovery/LAB-READINESS.md` dual containers:

```bash
docker rm -f juice-hvn5-hard juice-hvn5-node5 2>/dev/null || true
docker pull bkimminich/juice-shop:latest
docker run -d --name juice-hvn5-hard  -p 3010:3000 bkimminich/juice-shop:latest
docker run -d --name juice-hvn5-node5 -p 3011:3000 bkimminich/juice-shop:latest
# wait for HTTP 200 on both ports before arms
```

DVWA: provision two clean instances (or destroy/recreate between arms) and record ports on scorecard.

---

## 4. Invalid round (not a P1 segment)

A pair is **invalid** if any of:

| # | Condition |
|---|-----------|
| I1 | Scorecard red lines **R0–R6** not all Y (see juice/dvwa templates) |
| I2 | Hard **blocked@init** / false-death before discovery (map readiness R1) |
| I3 | Shared or dirty target instance across arms |
| I4 | Model provider/id strings **differ** between arms (violates M1) |
| I5 | Mislabelled arm (soft or Main-act strip as Hard; Node5 claimed as product Node) |
| I6 | Answer keys / scorecard / write-ups injected into agent-facing input |
| I7 | Wall-clock missing **and** cannot be reconstructed — treat as invalid unless operator supplies credible evidence |

Invalid → do **not** judge P1 pass; fix lab/process and re-run with new stamp (or clearly marked re-run).

---

## 5. Valid segment → P1 pass (per target)

1. Both arms complete under this protocol.  
2. Offline scorecard filled (`scorecard-*-template.md`).  
3. **Valid segment** (R0–R6 + filled card).  
4. **F2** discovery floor + process not collapsed.  
5. **J1** human total: Hard ≥ Node5 (M1 package).  

→ **Target P1 pass.**  
Juice pass unlocks DVWA campaign (O1). Both pass unlock X1 delete ticket — not this file.

---

## 6. Operator sequence (Juice example)

1. Set **identical** model env (M1).  
2. Provision **two clean** Juice instances (T1).  
3. Confirm Hard thin path ready (map R1 / Task R1).  
4. Run **Hard** on instance A → harvest `…/juice/hard/`.  
5. Run **Node5** on instance B → harvest `…/juice/node5/`.  
6. Fill `…/juice/scorecard.md` offline (J1/F2).  
7. If P1 fail: optimize **Hard only**, new stamp, repeat.  
8. If P1 pass: same protocol for **DVWA**.

---

## 7. Related assets

| Asset | Path / link |
|-------|-------------|
| Scorecards | `scorecard-juice-template.md`, `scorecard-dvwa-template.md` |
| Tree README | `README.md` |
| Node5 invocation research | `docs/wayfinder/node5-lab-invocation-juice-dvwa.md` |
| Hard/soft invocation research | `docs/wayfinder/hard-soft-juice-arm-invocation.md` |
| Hard R1 inventory | `docs/wayfinder/hard-graph-r1-readiness-inventory.md` |
