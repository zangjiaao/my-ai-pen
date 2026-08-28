# Expert packs (catalog)

Independent **expert pack** units maintained outside the Node harness.

**Runtime contracts:** [`docs/specs/expert-offers.md`](../docs/specs/expert-offers.md), [`docs/specs/harness.md`](../docs/specs/harness.md), [`docs/specs/pen-tools-sandbox.md`](../docs/specs/pen-tools-sandbox.md), [`docs/specs/task-graph.md`](../docs/specs/task-graph.md) (Graph close-out / book path)  
**Lab scorecard (offline #164):** [`docs/wayfinder/lab-scorecard-process-discovery-164.md`](../docs/wayfinder/lab-scorecard-process-discovery-164.md) · `node4/scripts/score-process-discovery-139.py`  
**Product:** [`docs/prd.md`](../docs/prd.md) · **Cleanup plan:** [`docs/project-cleanup-plan.md`](../docs/project-cleanup-plan.md)  
(Experts = target families; stages = skills; pipeline = Case + user @ — not stage-named Experts.)

**Pack authoring (system prompt layers):** Product Agent system prompts assemble as **Base → Profession → Runtime → Task**. Pack `mission.md` / `work.md` are the **Profession** layer (seat how-to only). Put Free vs Graph harness and tool catalogs in **Runtime** (host-owned), this-turn facts in **Task**, and attack-class procedure depth in **skill bodies**—not always-on Profession. Do **not** re-author platform-citizen / next_steps longform in `work.md` — host prepends citizen into mission at pack load (appears in Profession today; not yet a separate Base string — Spec [#395](https://github.com/zangjiaao/my-ai-pen/issues/395) / [`prompt-layers.md`](../docs/specs/prompt-layers.md) §3.3.1). Rule of thumb, ownership table, and **expert pack author checklist** (`mission` = identity · `work` = hard rules short · skills = class depth; opening-skill mutual exclusion; no citizen/Graph law in work): [`docs/specs/prompt-layers.md`](../docs/specs/prompt-layers.md) §3 / §10 / §10.1 (Spec [#386](https://github.com/zangjiaao/my-ai-pen/issues/386) · [#405](https://github.com/zangjiaao/my-ai-pen/issues/405)).

| Path | Role |
|------|------|
| `experts/<id>/pack.json` | Identity, tools, skills, aliases, booking mode |
| `experts/<id>/mission.md` | Mission lines (system prompt **Profession** layer) |
| `experts/<id>/work.md` | How-to-work lines (**Profession** core; keep short — see prompt-layers Spec) |
| `experts/<id>/skills/` | Pack-scoped methodology skills (progressive load; not always-on Profession) |
| `experts/<id>/recipes/` | Optional non-answer templates |
| `experts/<id>/refs/` | Optional on-demand payload/component cards (pentest: `refs/payloads`, `refs/components`) |
| `experts/<id>/CHANGELOG.md` | Pack release notes (versioning; L2 sandbox notes when relevant) |
| `experts/<id>/pack.json` | Includes optional `"version"` semver |
| `experts/RESEARCH-SOURCES.md` | Which `research/` trees inform pack methodology (adapted, not vendored) |
| `catalog.json` | Machine-readable list of pack ids + aliases (platform + Node) |

## Node as runtime

The product Node (**Node4 lineage / Graph × Pi**) runs **Expert packs** (one caste). Built-in `default` is a pack that currently declares **no** Graphs (ledger assist). Other catalog packs add tools/skills and may declare `graphs/hard/*.json`. **Pentest DoD** = **Graph × Pi** when the user permits a declared graph (`app_assessment`, `redteam_deep`; thin lab alias for assessment only). **Every Expert Session defaults to Free** (UI Graph **不指定**). **Soft scenario graphs are retired** (#68 / #76). After Graph complete, continue-chat stays in-envelope without auto full re-run (C1 / #78). Graph stages use pi inside a product-owned runner. ADR 0001 B1: fallback B retired; no live Node5 tree.

**Model B — platform citizen base + specialist overlay:**

- At pack load (`node4/src/experts/load-pack.ts`), every expert pack is injected with **read** ledger tools + Scope/asset rules (`roles/platform-citizen.ts`). You do **not** need to list those tools in every `pack.json` (optional for docs; runtime de-dupes).
- Hard Graph stage tools are the pack file `graphs/hard/*.json` `tools.allow`. Pentest graphs list inventory reads (`platform_list_assets` / `platform_get_asset` / `platform_list_groups`) on every stage; create/enrich/assemble stay off that list. Node only filters pack tools by the JSON.
- After a stage L0 pass, Node prompts the run’s **one Feedback Agent** (same pi session + panel row; not configured per-stage in the JSON). It judges refine vs pass and whether to open **this hop’s** next stage. Captains do not self-vote stage-advance. Graph **Main** is also one pi session for the run (next stage = next turn, tools rebound); **Workers** may mint a new session per package.
- **default** = full citizen (R/W ledger, reports, handoff orchestration).
- **pentest / ctf / …** = citizen **read** + act tools (shell, finding, skills). Session isolation remains; platform knowledge is shared.
- Host **create** is never a free agent tool — user asset page, open-task Authorize, next-scope / promote, or Workset **adopt** only. Passive exposure (CT/DNS/Shodan-class) parks on Workset until that adopt.

1. **Built-in `default`** — always available; full platform ledger tools + light assist; **no** finding booking.
2. **Catalog** — this tree (source of **expert** pack content; not auto-loaded).
3. **Install root** — local expert copies (`node4/installed-experts/` by default, override `NODE4_EXPERTS_INSTALL`).

```bash
# From node4/
npx tsx src/expert-cli.ts list
npx tsx src/expert-cli.ts install ctf
npx tsx src/expert-cli.ts install pentest
npx tsx src/expert-cli.ts uninstall ctf
```

- **Product default participant**: `default` seat (not bare `runtime`).
- **Empty expert install** → only `default` (lab may still force bare `runtime` for A/B).
- **install** copies `experts/<id>` → install root only.
- **uninstall** removes only that install-root copy; cannot “uninstall” built-in `default`.
- Explicit **expert** `engagement`/`role` must match an **installed** pack or the task is blocked.
- `consult` catalog entry → **legacy alias / migration path to built-in `default`**. **Not** product Profession SoT (Default mission/work live in `node4/src/roles/default.ts`). Do not expand `experts/consult/` as a parallel assistant; runtime resolve already maps `consult` → `default`.

Platform `offers` remains permission/billing for **expert** packs; Node install is independent for lab comparison.

Remote marketplace / network hot-load is out of scope.

## Packs (catalog)

| id | Purpose |
|----|---------|
| `default` | **Target built-in seat** (workspace assistant); not a commercial Expert instance |
| `pentest` | Application security (Web/API); product Expert Graph template `app_assessment` |
| `ctf` | CTF web player |
| `consult` | **LEGACY alias → built-in `default`** only — **not** product Profession SoT; do not maintain as parallel assistant |
| `llm-security` | Model and Agent security (Guide + DeepTeam methodology skills) |
| `code-audit` | Source code assessment (Argo-style validate / partition) |
| `alert-triage` | Alert / detection triage + purple replay (Guide) |
