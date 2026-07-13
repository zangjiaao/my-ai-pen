# Expert packs (catalog)

Independent **expert pack** units maintained outside the Node harness.

| Path | Role |
|------|------|
| `experts/<id>/pack.json` | Identity, tools, skills, aliases, booking mode |
| `experts/<id>/mission.md` | Mission lines (system prompt) |
| `experts/<id>/work.md` | How-to-work lines |
| `experts/<id>/skills/` | Pack-scoped methodology skills |
| `experts/<id>/recipes/` | Optional non-answer templates |
| `catalog.json` | Machine-readable list of pack ids + aliases (platform + Node) |

## Node as runtime

Node4 loads packs from:

1. **Catalog** — this tree (source of truth for pack content).
2. **Install root** — local copies enabled on this node (`node4/installed-experts/` by default, override `NODE4_EXPERTS_INSTALL`).

```bash
# From node4/
npx tsx src/expert-cli.ts list
npx tsx src/expert-cli.ts install ctf
npx tsx src/expert-cli.ts uninstall ctf
```

- **install** copies `experts/<id>` → install root (does not delete catalog).
- Installing a non-default pack **also seeds pentest** if missing (same additive default as platform offers).
- **uninstall** removes only the install-root copy of that pack.
- Empty install set → effective default **pentest** only (loaded from catalog).
- Blank engagement always resolves to **pentest** when pentest is installed/effective; if pentest was explicitly uninstalled, blank engagement is **blocked**.

Platform `offers` remains product permission/billing; pack **content** comes from this catalog + node install.

Remote marketplace / network hot-load is out of scope.
