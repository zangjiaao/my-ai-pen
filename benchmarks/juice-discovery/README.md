# Juice discovery lab (offline evaluation)

**Purpose:** First-segment **dual-arm** live lab artifacts and **offline** scorecards for Juice-class discovery capability.

**Not product authority.** Does not drive prompts, Hard Graph gates, or runtime checklists.

## Layout

| Path | Role |
|------|------|
| [`scorecard-template.md`](./scorecard-template.md) | **FROZEN** offline scorecard (human fill) for first dual-arm segment. |
| [`LAB-READINESS.md`](./LAB-READINESS.md) | Dual clean Juice instances (ports **3010/3011**), recreate cmds, RoE, pre-arm checklist. |
| `runs/<stamp>/` | One dual-arm segment (Hard primary + product soft control). See template §6. |

## Red lines

- **Offline only** — do not paste this tree into agent prompts or inject challenge lists / payloads into product.
- **No answer keys in runtime** — align with `docs/prd.md` 无靶场答案键 and [Decision package: Juice Shop discovery capability route](https://github.com/zangjiaao/my-ai-pen/issues/35).
- Historical OMP lab `benchmarks/omp-juice-20260719` is engineering reference only — **not** the product soft control arm for this map.
- **Density:** score **distinct evidence-backed hits per include class** (multi-location), not “one per class then stop,” and not full write-up challenge coverage.

## Map

[Wayfinder: First live dual-arm Juice discovery proof + offline scorecard](https://github.com/zangjiaao/my-ai-pen/issues/46)  
Freeze: [Grilling: freeze juice-discovery scorecard + run artifact layout](https://github.com/zangjiaao/my-ai-pen/issues/51)
