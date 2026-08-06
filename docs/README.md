# Documentation index

## Source of truth (current)

| Doc | Role |
|-----|------|
| [`../AGENTS.md`](../AGENTS.md) | Agent engineering rules; Graph × Pi product path |
| [`prd.md`](prd.md) | Product requirements — platform + bound Node candidate + experts |
| [`v1-delivery.md`](v1-delivery.md) | V1 delivery scope / non-goals / install boundary |
| [`design.md`](design.md) | UI design system |
| [`project-cleanup-plan.md`](project-cleanup-plan.md) | Executable cleanup plan (staged PR checklist) |

### Runtime contracts (`docs/specs/`)

Node4 implementation detail (Graph × Pi product path).

| Doc | Role |
|-----|------|
| [`specs/harness.md`](specs/harness.md) | OMP-class harness (no agent finish) — `node4/` |
| [`specs/task-graph.md`](specs/task-graph.md) | Free vs Graph work mode (scenario graphs) |
| [`specs/hypothesis-evidence.md`](specs/hypothesis-evidence.md) | Optional Expert Graph hypothesis queue + progressive skill disclosure (map #266) |
| [`specs/finding-identity.md`](specs/finding-identity.md) | Ledger identity (`vuln_type` + file location) + New-only narration (Spec #275) |
| [`specs/pen-tools-sandbox.md`](specs/pen-tools-sandbox.md) | Unified pen-sandbox (shell + browser) |
| [`specs/expert-offers.md`](specs/expert-offers.md) | Node packs + Expert instances (@mention routing) |
| [`specs/ctf-role.md`](specs/ctf-role.md) | CTF role pack operator notes |
| [`specs/ci-cd.md`](specs/ci-cd.md) | CI/CD: product-smoke (Phase A), product-deep (Phase B dispatch), beta-deploy, secrets |
| [`deploy/beta-bootstrap.md`](deploy/beta-bootstrap.md) | Operator bootstrap runbook for internal beta host |

### Agent process config

| Doc | Role |
|-----|------|
| [`agents/issue-tracker.md`](agents/issue-tracker.md) | GitHub Issues / wayfinder operations |
| [`agents/triage-labels.md`](agents/triage-labels.md) | Triage label vocabulary |
| [`agents/domain.md`](agents/domain.md) | Domain docs consumer rules |

### Related (outside `docs/`)

| Path | Notes |
|------|--------|
| [`../experts/README.md`](../experts/README.md) | Expert pack catalog |
| [`../benchmarks/`](../benchmarks/) | **Frozen** lab evaluation assets (not product authority; includes historical Hard-vs-Node5) |
| [`wayfinder/lab-scorecard-process-discovery-164.md`](wayfinder/lab-scorecard-process-discovery-164.md) | Dual-target (DVWA+Juice) offline scorecard invocation (#164) |
| [`../node4/scripts/score-process-discovery-139.py`](../node4/scripts/score-process-discovery-139.py) | Score script for process + close-out Product state |
| [`../research/`](../research/) | **Frozen** third-party reference clones (not product) |

## Runtime code

- **Product Node path:** Graph × Pi on `node4/` only (ADR 0001 B1 — fallback B retired; `node5/` deleted)
- **Product:** `platform/`, `node4/`, `experts/`, `sandbox/` (pen-sandbox)
- **Legacy (plan-delete after gates):** `node/`, `node2/`, `node3/` — do not expand product behavior
- **Frozen:** `research/`, `benchmarks/`

## Spec precedence

`AGENTS.md` → `docs/prd.md` → `docs/specs/harness.md` (Node4) → other `docs/specs/*` / `docs/v1-delivery.md`
