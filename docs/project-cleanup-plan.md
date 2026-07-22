# Project cleanup plan

**Status:** PR1–PR3 executed on main (review recommended)  
**Authority:** assembled from [Wayfinder: Project state cleanup plan](https://github.com/zangjiaao/my-ai-pen/issues/1) closed decisions  
**Date:** 2026-07-23  

This document is the **executable cleanup plan**. It does **not** perform deletes or moves by itself—run the checklist in later sessions.

---

## 1. Purpose & non-goals

### Purpose

Converge a half-rewritten repo into a navigable state:

1. **Docs:** small product trunk + `docs/specs/` runtime contracts; hard-delete obsolete plans and archive noise.
2. **Code tree:** keep co-equal Node candidates `node4/` and `node5/` until PK; plan-delete legacy `node/`, `node2/`, `node3/` after hygiene gates; **freeze** `research/` and `benchmarks/`.
3. **Wording:** replace “node4 only” sole-kernel language with dual-candidate rules so docs match product intent.

### Non-goals

| Out of scope | Why |
|--------------|-----|
| Choosing the final Node (`node4` vs `node5` PK winner) | Separate effort after comparison |
| Moving or deleting `research/` | Third-party reference clones; frozen |
| Moving or deleting `benchmarks/` | Lab evaluation assets for future Node capability scoring; frozen |
| tmp / workspace / `node_modules` volume hygiene | Not the primary path of this plan |
| Expanding product behavior on legacy trees | Forbidden |

---

## 2. Dual-track wording mandates

### Role model (pre-PK)

| Tree | Label | Rules |
|------|--------|--------|
| `node4/` | **Node candidate** (co-equal) | May be bound by platform for a deployment; `docs/specs/*` may describe this candidate’s implementation detail with explicit framing |
| `node5/` | **Node candidate** (co-equal) | Same status as node4; comparison/lab work allowed; **not** a lesser “side project” in product language |
| `node/`, `node2/`, `node3/` | **Legacy reference** | Plan-delete after hygiene gates; do not expand product behavior |
| `research/` | **Third-party reference** | Frozen; not product |
| `benchmarks/` | **Lab evaluation assets** | Frozen; not product authority; keep for future Node scoring |

### Forbidden phrasing

- “Runtime to maintain: node4 only”
- “product kernel is permanently node4”
- “node5 is non-product / ignore”
- Any sentence that **declares a PK winner**

### Required phrasing

- `node4/` and `node5/` are **co-equal candidates** until PK
- Docs **do not pick a winner**
- Each deployment **binds platform to exactly one** Node candidate via **explicit configuration**
- V1 docs **must not name a default** Node candidate; install/ops lists both options without ranking

### Mandatory replacement paragraph for `AGENTS.md`

> **Runtime candidates (pre-PK):** `node4/` and `node5/` are **co-equal Node implementation candidates**. The platform binds to **exactly one** candidate per deployment; documentation does **not** declare a winner. **Legacy** `node/`, `node2/`, `node3/`: plan-delete after gates — do not expand product behavior there. **`research/`**: frozen third-party reference (not product). **`benchmarks/`**: frozen lab evaluation assets (not product authority). Product work targets platform + the bound candidate + `experts/`.

### Spec precedence (until PK)

`AGENTS.md` → `docs/prd.md` → `docs/specs/harness.md` (candidate-specific) → other `docs/specs/*` / `docs/v1-delivery.md`

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

### Keep (pre-PK)

| Tree | Notes |
|------|--------|
| `node4/` | Co-equal Node candidate |
| `node5/` | Co-equal Node candidate |
| `platform/` | Product |
| `experts/` | Product packs |
| `sandbox/` | pen-sandbox (product-adjacent) |

### Frozen (do not move/delete)

| Tree | Notes |
|------|--------|
| `research/` | Third-party reference clones |
| `benchmarks/` | Lab evaluation for future Node capability assessment; not product authority |

### Plan-delete after gates — legacy runtimes

Audit ([#4](https://github.com/zangjiaao/my-ai-pen/issues/4)): **no product-required unique logic** vs node4/node5. Plan-delete all three is supported.

| Tree | Verdict | Hygiene gate before delete |
|------|---------|----------------------------|
| `node/` | safe-to-delete-after | Drop or retarget lab scripts that import `pentest_node`: `scripts/agent_autonomy_smoke.py`, `scripts/docker_sandbox_smoke.py`, `scripts/docker_sandbox_real_smoke.py`, `scripts/node_alpha_smoke.py`, `scripts/standalone_import_smoke.py` |
| `node2/` | safe-to-delete-after | Optional: extract a one-page design note if Caido/traffic archaeology still wanted; **not** a product dependency |
| `node3/` | safe-to-delete-after | Confirm Strix-on-platform comparison is retired (control arm = Node5). Platform `node3_strix` checkpoint UI may remain as dead-compat |

**Do not** delete `node4/` or `node5/` as part of this cleanup.

---

## 5. File rewrite list

Apply dual-track mandates (section 2) to:

| # | Path | What to change |
|---|------|----------------|
| 1 | `AGENTS.md` | Replace “Runtime to maintain: node4 only” (and sole-kernel language) with mandatory paragraph; update living-sources list if needed |
| 2 | `docs/prd.md` | Product model: dual candidates + bind-exactly-one; remove permanent node4-only claims |
| 3 | `docs/v1-delivery.md` | Delivery boundary: no default candidate; ship path describes binding a candidate + platform + experts |
| 4 | `docs/README.md` | Index for trunk + `docs/specs/` + dual-track; drop pointers to deleted plans/archive |
| 5 | `docs/specs/harness.md` **preamble only** | After move from `docs/specs/harness.md`: open with “describes **one candidate’s** harness behavior; peer is `node5/`; no winner declared.” Body may still document node4 implementation detail |

Also fix broken links repo-wide after PR1 moves (grep old paths).

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
