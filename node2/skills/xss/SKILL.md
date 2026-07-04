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
