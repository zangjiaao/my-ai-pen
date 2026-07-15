# Expert packs (catalog)

Independent **expert pack** units maintained outside the Node harness.

**Roadmap / collaboration model:** [`docs/multi-expert-collaboration-plan.md`](../docs/multi-expert-collaboration-plan.md)  
(Experts = target families; stages = skills; pipeline = Case + handoff — not stage-named Experts.)

| Path | Role |
|------|------|
| `experts/<id>/pack.json` | Identity, tools, skills, aliases, booking mode |
| `experts/<id>/mission.md` | Mission lines (system prompt) |
| `experts/<id>/work.md` | How-to-work lines |
| `experts/<id>/skills/` | Pack-scoped methodology skills |
| `experts/<id>/recipes/` | Optional non-answer templates |
| `catalog.json` | Machine-readable list of pack ids + aliases (platform + Node) |

## Node as runtime

Node4 is a **clean OMP-class agent runtime** by default (no experts installed).

1. **Catalog** — this tree (source of pack content; not auto-loaded).
2. **Install root** — local copies enabled on this node (`node4/installed-experts/` by default, override `NODE4_EXPERTS_INSTALL`).

```bash
# From node4/
npx tsx src/expert-cli.ts list
npx tsx src/expert-cli.ts install ctf
npx tsx src/expert-cli.ts install pentest
npx tsx src/expert-cli.ts uninstall ctf
```

- **Default**: empty install → **no expert packs**; blank `engagement` runs **bare runtime** (`id=runtime`: shell/todo density, no session/skill/captcha).
- **install** copies `experts/<id>` → install root only (does **not** auto-seed other packs; catalog unchanged).
- **uninstall** removes only that install-root copy.
- Explicit `engagement`/`role` must match an **installed** pack or the task is blocked.
- This split enables A/B: bare OMP runtime vs same runtime + expert pack.

Platform `offers` remains product permission/billing (may still default offer pentest for product UX); Node install is independent for lab comparison.

Remote marketplace / network hot-load is out of scope.
