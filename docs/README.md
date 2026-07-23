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

Candidate-specific implementation detail. See each file preamble for dual-track framing.

| Doc | Role |
|-----|------|
| [`specs/harness.md`](specs/harness.md) | OMP-class harness (no agent finish) — primarily documents `node4/` candidate |
| [`specs/task-graph.md`](specs/task-graph.md) | Free vs Graph work mode (scenario graphs) |
| [`specs/pen-tools-sandbox.md`](specs/pen-tools-sandbox.md) | Unified pen-sandbox (shell + browser) |
| [`specs/expert-offers.md`](specs/expert-offers.md) | Node packs + Expert instances (@mention routing) |
| [`specs/ctf-role.md`](specs/ctf-role.md) | CTF role pack operator notes |

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
| [`../benchmarks/`](../benchmarks/) | **Frozen** lab evaluation assets (not product authority) |
| [`../research/`](../research/) | **Frozen** third-party reference clones (not product) |
| [`../node5/README.md`](../node5/README.md) | Node5 candidate (CLI research control arm) |

## Runtime code

- **Product Node path:** Graph × Pi on `node4/` (ADR 0001); `node5/` lab/fallback B — bind **exactly one** Node process per deployment
- **Product:** `platform/`, `experts/`, `sandbox/` (pen-sandbox)
- **Legacy (plan-delete after gates):** `node/`, `node2/`, `node3/` — do not expand product behavior
- **Frozen:** `research/`, `benchmarks/`

## Spec precedence

`AGENTS.md` → `docs/prd.md` → `docs/specs/harness.md` (candidate-specific) → other `docs/specs/*` / `docs/v1-delivery.md`
