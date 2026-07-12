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
3. **Dual identity**: `session(op=jar_set|chain, actor=user_a)` and `actor=user_b`; `session(op=compare, actor=user_a, actor_b=user_b, url=...)` for horizontal/vertical access diffs.
4. **Browser path**: `browser(open)` → `snapshot` → interact; for stored XSS re-open the view page as another actor after export_cookies.
5. **Captcha channel**: `browser` screenshot or `captcha(fetch)` image URL with actor jar → `captcha(ocr)` if tesseract exists; always verify before submit.
6. **Source recon**: download JS/source maps/comments/API docs linked from the challenge page.
7. **Protocol tricks**: path normalization, null-byte class (when relevant), SSRF schemes only if surface suggests them — no random blasting.
8. **Tooling**: bounded `ffuf`/`sqlmap` via shell when the class matches; capture output as evidence.
9. **Time-box**: if still stuck after a rotation burst, mark the category blocked in audit notes and attack a different recon item.

## Density
- Prefer one multi-step `session` chain or one dense shell pipeline per turn.
- Multiple independent probes in the **same** turn when they do not share state.

## Do not
- Repeat the identical curl one-liner 20 times
- Shrink a maximize goal to “I got some flags”
- Invent answer keys for remaining levels
