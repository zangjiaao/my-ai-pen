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
| [`../benchmarks/collab-playbook-b/README.md`](../benchmarks/collab-playbook-b/README.md) | **Manual lab:** multi-expert collaboration dry-run (code-audit ↔ pentest); `case_context` work-group thread |

## Not product specs

| Path | Notes |
|------|--------|
| [`archive/`](archive/) | Historical only — **not** implementation authority. Includes finished plans (evidence A–E, phase milestones A–D, multi-expert collab v1) and older PLAID/Node2 drafts. |

## Runtime code

- **Maintain:** `node4/` — commercial execution kernel
- **Reference only (future cleanup):** `node/`, `node2/`, `node3/`
