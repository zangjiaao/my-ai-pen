# Juice discovery Hard-only second segment `20260723T200717Z`

| Field | Value |
|-------|-------|
| Stamp | `20260723T200717Z` |
| Purpose | Live verify #57 (`result.json` + `write` handoff) after first dual-arm map close |
| Runtime | core-only `runNode4Agent` (no pi-coding-agent) |
| Node SHA | `4337cba` |
| Hard | `hard/` — `app_assessment_thin` → **completed**, **8** findings, ~1016s |
| Soft | **not re-run** — control baseline remains `20260723T190830Z/soft` (6 findings) |
| Hard target | http://127.0.0.1:3010 (`juice-discovery-hard`) |
| Supersedes Hard of | `20260723T190830Z` (blocked@init, 0 findings) |
| Product fix under test | https://github.com/zangjiaao/my-ai-pen/issues/57 |
| Route SoT | https://github.com/zangjiaao/my-ai-pen/issues/35 |

### Verdict (checklist gates)

| Gate | Result |
|------|--------|
| P0 init handoff | **pass** |
| P1 discovery stages | **pass** (init→surface→class_probe→validate_book) |
| P2 scoreable Hard | **pass** (8 bookings) |

Hard 8 ≠ Soft product claim; Soft 6 remains control only. Node5 ~18 not used as SLA.
