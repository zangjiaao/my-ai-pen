---
name: ctf-stuck-rotation
description: Use when a CTF challenge stalls — rotate channels and encodings instead of repeating the same probe.
---

# CTF Stuck Technique Rotation

When no progress for several dense turns, change the channel — do not spam the same payload.

## When to load
- Same request/payload family failed repeatedly
- Goal continuation fires but findings are flat
- Soft locks (WAF text, empty body, same length)

## Rotation checklist (pick ONE new angle per burst)
1. **Encoding**: URL, double-URL, unicode, case, comment-inline (SQL/XSS class dependent).
2. **Parameter surface**: alternate param names from HTML/JS; headers (`X-Forwarded-*`, content-type); method switch GET/POST/JSON.
3. **Auth/session**: re-login with `session` jar; compare authenticated vs anonymous responses (length/status/body).
4. **Source recon**: download JS/source maps/comments/API docs linked from the challenge page.
5. **Protocol tricks**: path normalization, null-byte class (when relevant), SSRF schemes only if the challenge surface suggests them — no random blasting.
6. **Tooling**: bounded `ffuf`/`sqlmap` via shell when the class matches; capture output as evidence.
7. **Time-box**: if still stuck after a rotation burst, mark the category blocked in audit notes and attack a different recon item.

## Density
- Prefer one multi-step `session` chain or one dense shell pipeline per turn.
- Multiple independent probes in the **same** turn when they do not share state.

## Do not
- Repeat the identical curl one-liner 20 times
- Shrink a maximize goal to “I got some flags”
- Invent answer keys for remaining levels
