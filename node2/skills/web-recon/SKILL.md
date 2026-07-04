---
name: web-recon
description: Use when starting a web pentest, when attack surface is unclear, or when you need endpoints, parameters, technologies, authentication state, and candidate test targets before vulnerability probing.
---

# Web Recon

Start from real application behavior, not guessed URLs.

1. Use `browser` to open the target and complete login if credentials are available.
2. Use `browser(action="snapshot")` after login to capture cookies and storage.
3. Use `traffic(action="endpoints")` and `traffic(action="list")` to identify real requests.
4. Use `scan(scanner="httpx")`, `scan(scanner="katana")`, `scan(scanner="ffuf")`, or `scan(scanner="arjun")` when broader discovery is needed.
5. Normalize candidates as `(METHOD path, parameter)` tuples and call `coverage(action="untested")`.

Do not move to confirmation until a specific endpoint, parameter, and expected security property are defined.
