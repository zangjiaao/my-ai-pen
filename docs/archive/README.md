# Archived documents

These files are **historical** and are **not** product or agent source of truth.

They must **not** override:

- `AGENTS.md`
- `docs/prd.md`
- `docs/node4-harness.md`
- `docs/platform-default-agent-refactor.md` (active approved plan)

## Finished plans (archived 2026-07-17)

| Doc | Why archived |
|-----|----------------|
| [`evidence-quality-plan.md`](evidence-quality-plan.md) | Phases **A–E all done**; Case proof / `case_context` behavior is in code + living `prd.md` / `node4-harness.md` |
| [`phase-milestones.md`](phase-milestones.md) | Engineering gates A–D **shipped**; remaining product lab A/B is ops, not open design |
| [`multi-expert-collaboration-plan.md`](multi-expert-collaboration-plan.md) | Minimal Case collab model **landed**; next conversation-model work is `docs/platform-default-agent-refactor.md` |

## Older historical drafts

PLAID / Node2-era designs (coverage-driven loops, `finish_scan`, multi-node product lines, etc.):

- `architecture.md`, `product-vision.md`, `product-roadmap.md`, `harness-v2.md`, …
- Offline benchmark tables (if present) are for **human scoring only** — never inject into agent prompts, role packs, or runtime gates.

Legacy runtimes (`node/`, `node2/`, `node3/`) may still exist in the repo as **reference implementations**; product and new work target **Node4 only**.
