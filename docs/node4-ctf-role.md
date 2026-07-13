# Node4 CTF role pack

**Deliverable CTF “player” role** — selected only via structured fields:

- `engagement: "ctf"` or `role: "ctf"` (aliases: `ctf-web`, `challenge`)
- **Not** inferred from free-text instructions (Agents.md)

## What you get

| Piece | Content |
|-------|---------|
| Pack id | `ctf` (distinct from `pentest`) |
| Tools | todo, shell, fs, http, **session** (multi-actor), **browser**, **captcha**, script, finding, subagent, goal, **skill** |
| Skills | `ctf-web-recon`, `ctf-flag-verify`, `ctf-stuck-rotation` (list/load; not dumped into system prompt) |
| Recipes | `node4/recipes/ctf/` non-answer templates |
| Default goal | Maximize unique flags; partial clearance is not done |

## Session tool (dual identity)

Audit of real CTF runs showed hundreds of `curl -b/-c` shell turns. Use:

- `session(op=request|chain|jar_get|jar_set|history, actor=...)` — per-actor jars (`default`, `user_a`, `user_b`, `browser`, …)
- `session(op=compare, actor=user_a, actor_b=user_b, url=...)` — status/body length diffs for priv bugs
- `session(op=jar_copy, from_actor=browser, to_actor=user_a)`
- shell for scanners / gopher / custom scripts

## Browser + captcha (assist, don’t restrict)

- **browser (preferred path)**: Docker **strix-sandbox** (`ghcr.io/usestrix/strix-sandbox:1.0.0`) with in-container `agent-browser` — same class as Node2/Node3. Chromium + system deps live in the image; host does not need Chrome libraries.
  - Env: `NODE4_BROWSER_SANDBOX=1` (default). Set `0` / `host` to force host CLI.
  - Image override: `NODE4_BROWSER_SANDBOX_IMAGE`.
- **browser (host fallback)**: `npm i -g agent-browser && agent-browser install` (+ `install --with-deps` if shared libs missing). Used only when sandbox cannot start.
- Actions: open/snapshot/click/fill/screenshot/export_cookies (cookies → session actor jars).
- **captcha**: `fetch` image with actor cookies; `ocr` via host tesseract if present (best-effort).
- If browser/OCR missing, tools return install guidance — agent may still use shell.

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
