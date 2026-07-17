# Expert packs (catalog)

Independent **expert pack** units maintained outside the Node harness.

**Active conversation plan:** [`docs/platform-default-agent-refactor.md`](../docs/platform-default-agent-refactor.md)  
**Historical collab notes:** [`docs/archive/multi-expert-collaboration-plan.md`](../docs/archive/multi-expert-collaboration-plan.md)  
(Experts = target families; stages = skills; pipeline = Case + user @ — not stage-named Experts.)

| Path | Role |
|------|------|
| `experts/<id>/pack.json` | Identity, tools, skills, aliases, booking mode |
| `experts/<id>/mission.md` | Mission lines (system prompt) |
| `experts/<id>/work.md` | How-to-work lines |
| `experts/<id>/skills/` | Pack-scoped methodology skills |
| `experts/<id>/recipes/` | Optional non-answer templates |
| `experts/RESEARCH-SOURCES.md` | Which `research/` trees inform pack methodology (adapted, not vendored) |
| `catalog.json` | Machine-readable list of pack ids + aliases (platform + Node) |

## Node as runtime

Node4 is an OMP-class agent runtime with a **built-in `default` seat** (工作台助手) plus optional expert packs.

1. **Built-in `default`** — always available; platform ledger tools + light assist; **no** finding booking. Product target: [`docs/platform-default-agent-refactor.md`](../docs/platform-default-agent-refactor.md).
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
- `consult` catalog entry → **alias / migration path to `default`**.

Platform `offers` remains permission/billing for **expert** packs; Node install is independent for lab comparison.

Remote marketplace / network hot-load is out of scope.

## Packs (catalog)

| id | Purpose |
|----|---------|
| `default` | **Target built-in seat** (workspace assistant); not a commercial Expert instance |
| `pentest` | Application security (Web/API); templates app_assessment / redteam_deep |
| `ctf` | CTF web player |
| `consult` | **Legacy alias → `default`** (stub pack during migration) |
| `llm-security` | Model and Agent security (Guide + DeepTeam methodology skills) |
| `code-audit` | Source code assessment (Argo-style validate / partition) |
| `alert-triage` | Alert / detection triage + purple replay (Guide) |
