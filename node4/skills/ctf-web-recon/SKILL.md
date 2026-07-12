---
name: ctf-web-recon
description: Use at CTF web start or when challenge surface is unclear — enumerate levels/routes/params before deep exploit.
---

# CTF Web Recon

Enumerate first; exploit second. Do not invent challenge answer keys.

## When to load
- First contact with a multi-challenge web CTF
- After solving a few easy flags, before declaring “done”
- When you only know the base URL

## Process
1. **Map entrypoints** with `session` (or shell): `/`, robots, sitemap, common `level*`/`chal*` paths, linked pages from HTML.
2. **Inventory challenges** from YOUR recon only (page titles, forms, API paths, JS bundles). Keep a coarse `todo` phase list of categories — not one todo per flag.
3. For each challenge surface, record: method, path, parameters, auth/cookie needs.
4. Prefer `session(op=chain)` for login → next step flows so the cookie jar stays durable.
5. Read client JS/comments/error text for hints **from the target**, never from imagined answer sheets.
6. Only after a surface is named, form a **hypothesis** (e.g. “SQLi on login user”) and move to class-specific testing.

## Stop conditions for recon phase
- You can list reachable challenges/modules from evidence
- You know which items remain unsolved from that list

## Booking
- Recon alone is not a finding. Book only proven flags/vulns via `finding(confirm)+evidence_ids`.
