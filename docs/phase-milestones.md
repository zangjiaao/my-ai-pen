# Product milestones: Phase A–D (pentest expert sell)

Living gate board for the **penetration-testing expert** as the main product sell, plus report, dashboard, and scheduled tasks.

Aligned with `prd.md`, `node-expert-offers.md`, `AGENTS.md`, and research-inspired product shape (skills + evidence booking + visible engagement + cron retest).

**Last updated:** 2026-07-14

---

## Non-promises (all phases)

- No target-specific **answer keys**, fixed vulnerability lists, or expected-count gates in packs or UI.
- No **keyword/NLP** inventing of `engagement` from free-text user prompts.
- No **hardcoded fake findings**, fake agent progress, or sales-theater dashboard rows.
- No remote pack marketplace / network hot-load (this phase).
- Local weak “cyber 8B” models are **not** the default agent brain; API-class tool-calling models remain the lab default.

---

## Phase A — Expert pack earns the title

| Field | Content |
|-------|---------|
| **Purpose** | Make installed `pentest` pack a real methodology + tool-density upgrade over bare OMP runtime. |
| **Status** | **shipped (engineering)** — 7 skills; session-first + early skill-load in `work.md`; smoke list/load + session tools. **Product lab A/B gate remains open** (DVWA/Juice bare vs pentest with skill/session tool_output > 0 when env allows). |
| **Exit criteria** | (1) Pack exposes **≥5 methodology skills** beyond pure process meta. (2) `work.md` steers **session-first** multi-step HTTP and **early skill(list/load)** without vuln answer keys. (3) Smoke/unit: skill ids loadable; skill tool list returns them. (4) Lab A/B (when env allows): pentest arm has **skill + session tool_output > 0** and findings not worse than bare on both DVWA and Juice. |
| **Code** | `experts/pentest/` (`pack.json`, `work.md`, `skills/*`), `node4` resolve/smoke |

---

## Phase B — Findings → structured report

| Field | Content |
|-------|---------|
| **Purpose** | Export a client-shaped report from **real** booked findings + evidence references. |
| **Status** | **shipped (engineering)** |
| **Exit criteria** | (1) Pure builder maps finding JSON → markdown sections (summary, scope/method, details, remediation, appendix). (2) Titles/severities from input appear in output. (3) No invented CVEs when input has none. (4) Platform and/or node CLI can invoke the same transform. |
| **Code** | `node4/src/reports/`, `platform/backend/app/services/engagement_report.py`, report API hooks |

---

## Phase C — Engagement dashboard

| Field | Content |
|-------|---------|
| **Purpose** | Show **agent work state + findings** for an engagement from real events / DB, not fixtures. |
| **Status** | **shipped (engineering)** |
| **Exit criteria** | (1) API or snapshot DTO exposes status, timeline-ish activity, severity-aware findings list. (2) UI panel consumes that DTO. (3) Unit test: DTO includes input finding titles/severities. |
| **Code** | `platform/backend/app/services/engagement_dashboard.py`, API route, `RightPanel` / conversation dashboard strip |

---

## Phase D — Scheduled tasks

| Field | Content |
|-------|---------|
| **Purpose** | Operator defines a schedule that later dispatches a **structured** task (target, scope, explicit engagement). |
| **Status** | **shipped (engineering)** |
| **Exit criteria** | (1) Create/list schedule via API (or service). (2) Tick/fire builds `task_assign`-shaped envelope with engagement. (3) Unit test forces a fire and asserts structured fields. |
| **Code** | `platform/backend/app/services/schedule_tasks.py`, API `schedules`, optional UI list |

---

## Demo vs deliver alignment

| Milestone | Customer-facing | Expert pack claim |
|-----------|-----------------|-------------------|
| Now (pre-A lab gate) | Controlled lab demo | **Preview** |
| A lab gate closed | Demo + “pack beats bare” numbers | **Main sell** |
| B | + formal report export | Project delivery |
| C | + workbench dashboard | Platform differentiation |
| D | + scheduled retest | Continuous / MSSP narrative |

---

## Implementation notes

- Prefer pure transforms unit-tested with real-shaped JSON.
- Pack skills: methodology only — no DVWA/Juice answer keys.
- Dashboard and schedules must read/write the same truth as task events and findings stores.
