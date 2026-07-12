# Node4 CTF role pack

**Deliverable CTF “player” role** — selected only via structured fields:

- `engagement: "ctf"` or `role: "ctf"` (aliases: `ctf-web`, `challenge`)
- **Not** inferred from free-text instructions (Agents.md)

## What you get

| Piece | Content |
|-------|---------|
| Pack id | `ctf` (distinct from `pentest`) |
| Tools | todo, shell, fs, http, **session**, script, finding, subagent, goal, **skill** |
| Skills | `ctf-web-recon`, `ctf-flag-verify`, `ctf-stuck-rotation` (list/load; not dumped into system prompt) |
| Recipes | `node4/recipes/ctf/` non-answer templates |
| Default goal | Maximize unique flags; partial clearance is not done |

## Session tool

Audit of real CTF runs showed hundreds of `curl -b/-c` shell turns. Use:

- `session(op=request|chain|jar_get|jar_set|history)` for stateful HTTP
- shell for scanners / gopher / custom scripts

## Offline audit

```bash
cd node4
npx tsx src/ctf-audit-cli.ts /path/to/events.jsonl
```

Pure parser: `auditCtfEventsJsonl` in `src/runtime/ctf-audit.ts`.

## Operator notes

- Platform Goal switch can still supply a custom `goal_objective`; otherwise the pack seeds `defaultGoalObjective`.
- No challenge answer keys in skills or recipes.
- Next role (pentest+) can reuse the same pipeline: audit → tools/skills → pack.
