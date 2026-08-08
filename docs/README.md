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
| [`specs/participant-session.md`](specs/participant-session.md) | Case · Participant Session · work mode continuity (Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277)) |
| [`specs/graph-catalog-work-mode-ui.md`](specs/graph-catalog-work-mode-ui.md) | Graph L1 catalog (skill-like) + dual-rail composer/AgentRow (Spec [#278](https://github.com/zangjiaao/my-ai-pen/issues/278)) |
| [`specs/composer-graph-harness-bind.md`](specs/composer-graph-harness-bind.md) | Composer Graph + Expert → harness bind fail-closed; re-verify booking (Spec [#284](https://github.com/zangjiaao/my-ai-pen/issues/284)) |
| [`specs/engagement-graph-back-edges.md`](specs/engagement-graph-back-edges.md) | Constrained Engagement Graph (declarative back-edges) + `hypothesis_cycle` (Spec [#285](https://github.com/zangjiaao/my-ai-pen/issues/285)) |
| [`specs/engagement-graph-json-boundary.md`](specs/engagement-graph-json-boundary.md) | Graph JSON data-plane vs code standards-plane (topology/budgets in JSON; interpreter/predicates/projection/booking in code) |
| [`specs/lab-scorecard-hypothesis-cycle.md`](specs/lab-scorecard-hypothesis-cycle.md) | Offline dual-arm D0–D3 × R0–R3 scorecard (DVWA+Juice); never agent-facing (Spec #285 S6) |
| [`specs/hypothesis-evidence.md`](specs/hypothesis-evidence.md) | Optional Expert Graph hypothesis queue + progressive skill disclosure (map #266) |
| [`specs/finding-identity.md`](specs/finding-identity.md) | Ledger identity (`vuln_type` + file location) + New-only narration (Spec #275) |
| [`specs/base-booking-finding-id.md`](specs/base-booking-finding-id.md) | Base Runtime booking + unified finding_id mint (Spec [#279](https://github.com/zangjiaao/my-ai-pen/issues/279)) |
| [`specs/product-state-ui-projection.md`](specs/product-state-ui-projection.md) | Product state → UI passive projection; Findings/Evidence SoT (Spec [#280](https://github.com/zangjiaao/my-ai-pen/issues/280)) |
| [`specs/traffic-audit-activity.md`](specs/traffic-audit-activity.md) | Case traffic audit replaces right-panel Activity (`http`+`browser` Runtime hooks; not MITM V1) — Spec [#309](https://github.com/zangjiaao/my-ai-pen/issues/309) |
| [`specs/graph-stage-todo-l2.md`](specs/graph-stage-todo-l2.md) | Graph Todo = current-stage L2 only; no Free-style whole-map under L1 (Spec [#281](https://github.com/zangjiaao/my-ai-pen/issues/281)) |
| [`specs/stream-message-identity.md`](specs/stream-message-identity.md) | Remove live-slot-as-Message; stream_id list identity + pending chrome |
| [`specs/dialog-markdown-gfm.md`](specs/dialog-markdown-gfm.md) | Case-dialog shared GFM Markdown (`MarkdownText`); thinking soft-break; no raw HTML / no remote img — Spec [#327](https://github.com/zangjiaao/my-ai-pen/issues/327) |
| [`specs/timeline-activity-liveness.md`](specs/timeline-activity-liveness.md) | Thinking `status` + T1 empty running; pending speaker reuse; tool running S+ |
| [`specs/llm-stream-liveness.md`](specs/llm-stream-liveness.md) | LLM stream health stall + fail-closed incomplete streams (`without finish_reason`); diagnosis package — Spec [#353](https://github.com/zangjiaao/my-ai-pen/issues/353); adjacent [#305](https://github.com/zangjiaao/my-ai-pen/issues/305) / [#350](https://github.com/zangjiaao/my-ai-pen/issues/350) |
| [`specs/worker-process-audit.md`](specs/worker-process-audit.md) | Worker process audit dialog (Package turns + thinking/tools; Case rename; live + replay) — map [#253](https://github.com/zangjiaao/my-ai-pen/issues/253) / Spec [#308](https://github.com/zangjiaao/my-ai-pen/issues/308) |
| [`specs/choice-card-next-steps.md`](specs/choice-card-next-steps.md) | Unified Choice Card (next_steps + authorize preset); retire mechanical Next UI — Spec [#312](https://github.com/zangjiaao/my-ai-pen/issues/312); **amended by** [#313](https://github.com/zangjiaao/my-ai-pen/issues/313) (single-select + supplement + value-only) |
| [`specs/free-tasks-continue-integrity.md`](specs/free-tasks-continue-integrity.md) | Free Tasks = user progress SoT; ban silent init wipe; next_steps confirm = FIFO Session demand; soft completion honesty — Spec [#313](https://github.com/zangjiaao/my-ai-pen/issues/313) |
| [`specs/task-map-history.md`](specs/task-map-history.md) | Task Map lifecycle (seal/archive); **operator history dropdown superseded** by [#354](https://github.com/zangjiaao/my-ai-pen/issues/354) — Spec [#321](https://github.com/zangjiaao/my-ai-pen/issues/321) |
| [`specs/session-owns-runtime.md`](specs/session-owns-runtime.md) | Session owns captain runtime; Task = dispatch package only; collab Delete/Reset; incomplete handoff — Spec [#354](https://github.com/zangjiaao/my-ai-pen/issues/354); amends [#277](https://github.com/zangjiaao/my-ai-pen/issues/277)/[#283](https://github.com/zangjiaao/my-ai-pen/issues/283)/[#321](https://github.com/zangjiaao/my-ai-pen/issues/321) |
| [`specs/case-status-ledger-time-ui.md`](specs/case-status-ledger-time-ui.md) | Case Status metering ledger (tokens/cost + Sub) + atomic time UI (composer timer / B1 burst duration / chat stamps); Status no elapsed hero — Spec [#323](https://github.com/zangjiaao/my-ai-pen/issues/323); decouples from [#321](https://github.com/zangjiaao/my-ai-pen/issues/321) Task Map archive |
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
