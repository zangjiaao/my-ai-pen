# Documentation index

## Source of truth (current)

| Doc | Role |
|-----|------|
| [`../AGENTS.md`](../AGENTS.md) | Agent engineering rules (no hardcoded behavior, harness over restriction, structured engagement) |
| [`prd.md`](prd.md) | Product requirements — **platform + single Node (Node4)** |
| [`node4-harness.md`](node4-harness.md) | Node4 runtime north star (OMP-class harness, no agent finish) |
| [`design.md`](design.md) | UI design system |
| [`node4-ctf-role.md`](node4-ctf-role.md) | CTF role pack operator notes |
| [`node-expert-offers.md`](node-expert-offers.md) | Node packs + product Expert instances (@mention routing); target: Node `default` + experts |
| [`platform-default-agent-refactor.md`](platform-default-agent-refactor.md) | **Done:** remove platform conversation Agent → Node built-in `default` + platform data tools |
| [`../experts/README.md`](../experts/README.md) | Expert pack catalog (source of pack content) |
| [`expert-pack-capability-and-maintenance.md`](expert-pack-capability-and-maintenance.md) | **Active plan:** enhance pack discovery (ClaudeBrain-adapted methodology) + long-term pack/sandbox maintenance (L1/L2/L3, n-day runbook) |
| [`pentest-next-steps.md`](pentest-next-steps.md) | **Near-term roadmap** after pack 1.1.1: lab validation, sandbox nuclei hygiene, gap-driven patches, optional FOFA/OSINT (from main + BTW agreements) |
| [`../benchmarks/pentest-lab-1.1.1/README.md`](../benchmarks/pentest-lab-1.1.1/README.md) | Docker lab targets + standalone run recipes; [`LAB-NOTES.md`](../benchmarks/pentest-lab-1.1.1/LAB-NOTES.md) Phase L observations |
| [`pen-tools-sandbox.md`](pen-tools-sandbox.md) | **L2:** unified **pen-sandbox** for pentest expert (shell + browser); Strix fallback only |
| [`../benchmarks/collab-playbook-b/README.md`](../benchmarks/collab-playbook-b/README.md) | **Manual lab:** multi-expert collaboration dry-run (code-audit ↔ pentest); `case_context` work-group thread |

## Not product specs

| Path | Notes |
|------|--------|
| [`archive/`](archive/) | Historical only — **not** implementation authority. Includes finished plans (evidence A–E, phase milestones A–D, multi-expert collab v1) and older PLAID/Node2 drafts. |

## Runtime code

- **Maintain:** `node4/` — commercial execution kernel
- **Reference only (future cleanup):** `node/`, `node2/`, `node3/`
