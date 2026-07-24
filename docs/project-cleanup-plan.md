# Project cleanup plan

**Status:** PR1–PR3 executed on main; **X1 `node5/` delete + B1 fallback B retired** (map [#59](https://github.com/zangjiaao/my-ai-pen/issues/59) / task [#67](https://github.com/zangjiaao/my-ai-pen/issues/67), 2026-07-24)  
**Authority:** assembled from [Wayfinder: Project state cleanup plan](https://github.com/zangjiaao/my-ai-pen/issues/1) closed decisions; product path ADR 0001  
**Date:** 2026-07-24  

This document is the **executable cleanup plan**. Remaining work is legacy tree deletes after hygiene gates — not reopening Node PK.

---

## 1. Purpose & non-goals

### Purpose

Converge a half-rewritten repo into a navigable state:

1. **Docs:** small product trunk + `docs/specs/` runtime contracts; hard-delete obsolete plans and archive noise.
2. **Code tree:** product Node = **`node4/` only** (Graph × Pi); `node5/` **hard-deleted** after P1 parity (map #59); plan-delete legacy `node/`, `node2/`, `node3/` after hygiene gates; **freeze** `research/` and `benchmarks/`.
3. **Wording:** living docs name **unique** Node4 product lineage; do not reintroduce dual-kernel / fallback B language.

### Non-goals

| Out of scope | Why |
|--------------|-----|
| Resurrecting `node5/` or dual-kernel PK | Closed by ADR 0001 B1 + X1 |
| Moving or deleting `research/` | Third-party reference clones; frozen |
| Moving or deleting `benchmarks/` | Lab evaluation assets (incl. historical Hard-vs-Node5); frozen |
| tmp / workspace / `node_modules` volume hygiene | Not the primary path of this plan |
| Expanding product behavior on legacy trees | Forbidden |

---

## 2. Product Node wording (post-B1)

### Role model

| Tree | Label | Rules |
|------|--------|--------|
| `node4/` | **Product Node** | Platform binds to Node4 per deployment; `docs/specs/*` document this implementation |
| `node5/` | **Deleted (X1)** | Not in product tree; git history + `benchmarks/hard-vs-node5/` hold archaeology |
| `node/`, `node2/`, `node3/` | **Legacy reference** | Plan-delete after hygiene gates; do not expand product behavior |
| `research/` | **Third-party reference** | Frozen; not product |
| `benchmarks/` | **Lab evaluation assets** | Frozen; not product authority |

### Forbidden phrasing

- Treating `node5/` as a live bindable candidate
- “co-equal candidates until PK” / “fallback B on standby”
- Elevating pure Node5 as product Node without a **new** ADR

### Required phrasing

- Product Node lineage = **Node4 / Graph × Pi** (ADR 0001)
- Each deployment **binds platform to exactly one** Node process (**Node4**)
- Exit C (Runtime swap under Graph ownership) remains; **fallback B retired**

### Spec precedence

`AGENTS.md` → `docs/prd.md` → `docs/specs/harness.md` (Node4) → other `docs/specs/*` / `docs/v1-delivery.md`

---

## 3. Target docs tree

### KEEP — product trunk

| Path | Role |
|------|------|
| `docs/README.md` | Sole nav index |
| `docs/prd.md` | Product requirements / product authority |
| `docs/v1-delivery.md` | Delivery scope & boundaries |
| `docs/design.md` | UI design system |
| `docs/project-cleanup-plan.md` | This plan (ops note; may remain after execution or be retired once PR1–PR3 done) |

### MOVE/RENAME → `docs/specs/` (runtime contracts; not product trunk)

| From (today) | To (target) |
|--------------|-------------|
| `docs/specs/harness.md` | `docs/specs/harness.md` |
| `docs/specs/task-graph.md` | `docs/specs/task-graph.md` |
| `docs/specs/pen-tools-sandbox.md` | `docs/specs/pen-tools-sandbox.md` |
| `docs/specs/expert-offers.md` | `docs/specs/expert-offers.md` |
| `docs/specs/ctf-role.md` | `docs/specs/ctf-role.md` |

Content merge of harness + task-graph is **optional** and **not** required for plan completeness. After move, refresh all in-repo links.

### KEEP — agent process config (not product trunk)

| Path |
|------|
| `docs/agents/issue-tracker.md` |
| `docs/agents/triage-labels.md` |
| `docs/agents/domain.md` |

### DELETE (hard delete; git history is backup)

**Living plans / roadmaps:**

- `docs/platform-default-agent-refactor.md`
- `docs/expert-pack-capability-and-maintenance.md`
- `docs/pentest-next-steps.md`
- `docs/cyberstrikeai-reference.md`

**Archive tree (entire):**

- `docs/archive/**` (all files including README)

**Agent research artifacts only:**

- `docs/agents/research/**` (inventory / audit reports; conclusions live on closed GitHub issues)

### Archive whitelist

**Empty.** Do not maintain a new archive of deleted living docs.

### Post-PR1 expected shape (docs)

```text
docs/
├── README.md
├── prd.md
├── v1-delivery.md
├── design.md
├── project-cleanup-plan.md    # this file
├── agents/
│   ├── issue-tracker.md
│   ├── triage-labels.md
│   └── domain.md
└── specs/
    ├── harness.md
    ├── task-graph.md
    ├── pen-tools-sandbox.md
    ├── expert-offers.md
    └── ctf-role.md
```

---

## 4. Code-tree gates

### Keep (product)

| Tree | Notes |
|------|--------|
| `node4/` | Product Node (Graph × Pi) |
| `platform/` | Product |
| `experts/` | Product packs |
| `sandbox/` | pen-sandbox (product-adjacent) |

### Frozen (do not move/delete)

| Tree | Notes |
|------|--------|
| `research/` | Third-party reference clones |
| `benchmarks/` | Lab evaluation (incl. historical Hard-vs-Node5 P1); not product authority |

### Plan-delete after gates — legacy runtimes

Audit ([#4](https://github.com/zangjiaao/my-ai-pen/issues/4)): **no product-required unique logic** vs historical node4/node5. Plan-delete all three is supported.

| Tree | Verdict | Hygiene gate before delete |
|------|---------|----------------------------|
| `node/` | safe-to-delete-after | Drop or retarget lab scripts that import `pentest_node`: `scripts/agent_autonomy_smoke.py`, `scripts/docker_sandbox_smoke.py`, `scripts/docker_sandbox_real_smoke.py`, `scripts/node_alpha_smoke.py`, `scripts/standalone_import_smoke.py` |
| `node2/` | safe-to-delete-after | Optional: extract a one-page design note if Caido/traffic archaeology still wanted; **not** a product dependency |
| `node3/` | safe-to-delete-after | Confirm Strix-on-platform comparison is retired. Platform `node3_strix` checkpoint UI may remain as dead-compat |

**Do not** delete `node4/`. **`node5/` deleted (X1, 2026-07-24)** — not part of remaining cleanup.

---

## 5. File rewrite list (historical — dual-track era)

Pre-B1 dual-candidate rewrites (PR1–PR3) are **done**. Post-B1 living docs must state **Node4 only** (see section 2).

---

## 6. Ordered execution checklist

### PR1 — Docs fate

- [x] Create `docs/specs/` and move/rename the five runtime docs (section 3 table)
- [x] Hard-delete the four living plans/roadmaps
- [x] Hard-delete entire `docs/archive/`
- [x] Hard-delete `docs/agents/research/**` (if present)
- [x] Rewrite `docs/README.md` index for new shape (can be partial; full dual-track in PR2)
- [x] Grep and fix obvious path breakages from renames
- [x] Do **not** touch `research/` or `benchmarks/`

### PR2 — Dual-track wording

- [x] Apply rewrite list (section 5), including harness preamble
- [x] Grep for forbidden phrases: `node4 only`, `仅 Node4`, `Runtime to maintain`, etc.
- [x] Confirm V1 text names **no default** Node candidate

### PR3 — Legacy tree deletes

- [x] Satisfy `node/` script gate (delete/retarget five smokes)
- [x] Optional node2 design-note scrape (or explicitly skip)
- [x] Confirm node3 Strix comparison retired
- [x] Delete `node/`, `node2/`, `node3/` (or record waiver if deferred)
- [x] Confirm product smoke / CI still green (platform + bound candidate)
- [x] Confirm `research/` and `benchmarks/` still present

### Suggested order

Always **PR1 → PR2 → PR3**. Do not merge PR3 before gates. PR1 and PR2 may be squashed only if review prefers; keep PR3 separate for safer rollback.

---

## 7. Acceptance criteria

### Plan-done (this document)

- [x] All 8 sections present
- [x] Trunk / SPECS / DELETE tables embedded
- [x] Legacy delete gates listed
- [x] Dual-track rules + AGENTS paragraph embedded
- [x] `research/` and `benchmarks/` explicitly frozen
- [x] Staged-PR checklist is checkable
- [x] Execution-done criteria listed separately
- [x] File committed on a branch/PR ready for human review

### Execution-done (later sessions; not automatic)

- [x] PR1–PR3 executed on main (commits; push optional)
- [x] Living docs match KEEP + SPECS (+ this plan); agents config may still need add if missing
- [x] Forbidden dual-track phrasing removed from primary rewrite-list files
- [x] Legacy trees removed after script gate (node2 design-note scrape skipped)
- [x] `research/` and `benchmarks/` still present (frozen)

---

## 8. Pointers

| Artifact | Link |
|----------|------|
| Map | [Wayfinder: Project state cleanup plan](https://github.com/zangjiaao/my-ai-pen/issues/1) |
| Inventory (facts) | [Inventory living docs vs code reality](https://github.com/zangjiaao/my-ai-pen/issues/2) |
| Docs fate | [Living trunk set and delete list](https://github.com/zangjiaao/my-ai-pen/issues/3) |
| Legacy audit | [Audit legacy node/node2/node3 uniqueness](https://github.com/zangjiaao/my-ai-pen/issues/4) |
| Dual-track wording | [Dual-track wording for AGENTS and living docs](https://github.com/zangjiaao/my-ai-pen/issues/5) |
| Plan shape | [Cleanup plan doc shape and done criteria](https://github.com/zangjiaao/my-ai-pen/issues/6) |
| Write this file | [Write docs/project-cleanup-plan.md](https://github.com/zangjiaao/my-ai-pen/issues/7) |

Research report branches (optional until PR1 deletes local copies):

- `research/docs-inventory-vs-code`
- `research/legacy-node-uniqueness-audit`
