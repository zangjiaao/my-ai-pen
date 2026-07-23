# Lab readiness — first dual-arm Juice segment

**Ticket:** [Task: Juice lab readiness for first dual-arm segment](https://github.com/zangjiaao/my-ai-pen/issues/52)  
**Map:** [Wayfinder: First live dual-arm Juice discovery proof + offline scorecard](https://github.com/zangjiaao/my-ai-pen/issues/46)  
**Scorecard freeze:** R4/R5 require **independent clean Juice instances** per arm (segment invalid if shared dirty).

This note is **lab ops only** — not product runtime, not an answer key.

---

## Status (recorded 2026-07-23)

| Check | Status |
|-------|--------|
| Dual clean Juice reachable | **OK** |
| Hard arm URL | `http://127.0.0.1:3010` (container `juice-discovery-hard`) |
| Soft arm URL | `http://127.0.0.1:3011` (container `juice-discovery-soft`) |
| HTTP probe | both returned **200** after boot |
| Image | `bkimminich/juice-shop:latest` |
| RoE | app_assessment; Scope host `127.0.0.1` / `localhost` only; no off-box post-ex |
| Budget (L1) | suggested ≤2h wall-clock per arm; overrun noted on scorecard |

**Override note:** Package L1 default is `http://127.0.0.1:3000`. For this map we use **3010/3011** so dual-arm clean instances do not collide with long-lived host labs (`juice-shop:3000`, `penlab-juice:3001`). Scorecard segment meta must record the actual URLs.

---

## Provision / recreate (clean instances)

Run **before Hard arm**, then again **before soft arm** if either instance was polluted or you want a guaranteed clean soft start (soft must not reuse Hard’s dirty DB).

```bash
# Tear dedicated dual-arm containers (does not touch juice-shop / penlab-juice)
docker rm -f juice-discovery-hard juice-discovery-soft 2>/dev/null || true

docker pull bkimminich/juice-shop:latest

docker run -d --name juice-discovery-hard -p 3010:3000 bkimminich/juice-shop:latest
docker run -d --name juice-discovery-soft -p 3011:3000 bkimminich/juice-shop:latest

# Wait until both answer 200
for p in 3010 3011; do
  until curl -sf -o /dev/null "http://127.0.0.1:${p}/"; do sleep 2; done
  echo "ok :$p"
done
```

**Hygiene rule (frozen):**

| Arm | Use instance | Must not |
|-----|----------------|----------|
| Hard primary | `juice-discovery-hard` → `:3010` | Soft’s instance; shared dirty state |
| Soft control | `juice-discovery-soft` → `:3011` | Hard’s instance after Hard run without recreate |

Optional: recreate soft only after Hard finishes:

```bash
docker rm -f juice-discovery-soft
docker run -d --name juice-discovery-soft -p 3011:3000 bkimminich/juice-shop:latest
# wait for :3011 → 200
```

---

## RoE / Scope (both arms)

- **Engagement:** app_assessment  
- **In scope:** `127.0.0.1` / `localhost` on the chosen Juice port only  
- **Out of scope:** other host ports (DVWA, MinIO, Redis, sibling Juice) unless explicitly added to task Scope  
- **Forbidden:** off-box post-ex / host takeover  
- **No answer keys** in prompts or Hard Graph gates  

---

## Operator launch pointers (not the run itself)

From [Research: Hard vs product-soft arm invocation](https://github.com/zangjiaao/my-ai-pen/issues/50) / `docs/wayfinder/hard-soft-juice-arm-invocation.md` (research branch):

| Arm | Graph | Target URL |
|-----|-------|------------|
| Hard | standalone `--graph-id app_assessment_thin` (or product hard default) | `http://127.0.0.1:3010` |
| Soft | `--graph-id app_assessment` / UI「应用评估」 | `http://127.0.0.1:3011` |

Also green: A1 smoke ([Task: light smoke…](https://github.com/zangjiaao/my-ai-pen/issues/48)); scorecard frozen ([Grilling: freeze…](https://github.com/zangjiaao/my-ai-pen/issues/51)).

**Artifacts:** copy findings + short notes under `benchmarks/juice-discovery/runs/<stamp>/{hard,soft}/` per frozen template.

---

## Pre-arm checklist (operator)

- [ ] `curl -sf http://127.0.0.1:3010/` and `:3011/` → 200  
- [ ] Containers are **fresh** relative to that arm (recreate if unsure)  
- [ ] Task Scope points only at that arm’s URL  
- [ ] Scorecard stamp directory created  
- [ ] Hard arm first; soft second (map E1)  
- [ ] Budget clock started / noted  

---

## Not done by this ticket

Live discovery runs, scorecard fill, Graph deepen.
