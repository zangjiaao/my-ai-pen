---
name: xss
description: Use when input is reflected into HTML, JavaScript, attributes, URLs, templates, markdown, rich text, profile fields, admin views, or scanner output suggests XSS.
---

# XSS

Confirm execution context, not just reflection.

1. Use `http` to compare baseline and payload reflection.
2. Determine context: HTML text, attribute, script string, URL, JSON, DOM sink.
3. Use `browser` for JavaScript-heavy flows and to verify execution when safe.
4. Use `scan(scanner="dalfox")` for broad reflected XSS probing on precise URLs.
5. Confirm only with evidence of executable JavaScript in the victim context or a controlled browser-observed effect.
6. Mark coverage for each tested `(endpoint, param, xss)` tuple.

Raw payload echo without executable context is a candidate, not a confirmed finding.

## Stored XSS and out-of-band impact

- Storing a payload is not enough when impact requires an admin/bot to render it or an external callback.
- If the environment provides no callback URL, webhook receiver, or admin-bot visitor, record:
  - coverage status `blocked` or `skipped` with notes that name the **missing environment** (bot/callback), and/or
  - finish `incomplete` with that blocker when the engagement depends on the proof.
- Do not confirm full impact solely because the payload was stored or reflected without execution in a victim context.
- Prefer browser-observed execution when the same session can render the store (self-XSS vs admin XSS: label accurately).
