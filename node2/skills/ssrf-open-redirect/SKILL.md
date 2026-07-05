---
name: ssrf-open-redirect
description: Use when parameters named url, uri, callback, webhook, next, return, redirect, image, import, or fetch may control server-side fetches or redirects.
---

# SSRF And Open Redirect

Separate browser redirects from server-side fetches.

1. Identify whether the application returns a redirect, renders fetched content, or performs a server-side callback.
2. Look up `poc(action="get", vuln_class="open-redirect")` or `poc(action="get", vuln_class="ssrf")`.
3. For redirects, capture status and `Location` header or browser navigation to a harmless external target.
4. For SSRF, use a tester-controlled callback endpoint when available; do not probe metadata services unless explicitly authorized.
5. Confirm only with redirect control or server-side fetch evidence.
6. Mark coverage for the endpoint/parameter and the specific class tested.
