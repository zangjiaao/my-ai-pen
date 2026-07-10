---
name: web-recon
description: Use when starting a web pentest, when attack surface is unclear, or when you need endpoints, parameters, technologies, authentication state, and candidate test targets before vulnerability probing.
---

# Web Recon

Start from real application behavior, not guessed URLs.

1. Use `browser` to open the target and complete login if credentials are available.
2. Use `browser(action="snapshot")` after login to capture cookies and storage; immediately `actor(action="capture")` for each distinct identity.
3. Populate traffic from browser/http/scan. When a proxy source is configured, call `traffic(action="source_status")` and `traffic(action="sync")`.
4. **Mandatory for assess:** `traffic(action="analyze")` or `traffic(action="candidates")` before broad probing — prefer captured endpoints over guessed URLs.
5. Use `scan(scanner="httpx")`, `scan(scanner="katana")`, `scan(scanner="ffuf")`, or `scan(scanner="arjun")` when broader discovery is needed (OpenAPI/swagger, common API prefixes, SPA routes).
6. Normalize candidates as `(METHOD path, parameter)` tuples, seed `coverage`, then call `coverage(action="surface_quality")`, `coverage(action="next_work")`, and `coverage(action="untested")`.
7. Mid-run loop: after early findings, re-call `coverage(action="next_work")` and execute the top live probes (untested risk families + traffic candidates) before more skip/block marks.
8. Prefer `worker(role="recon"|…, task=…)` for separable packages from the workflow brief; workers share traffic/coverage/actors/evidence. Main agent keeps `finish_scan`.

Do not move to confirmation until a specific endpoint, parameter, and expected security property are defined.
Do not bulk-skip high-priority coverage to force `finish_scan(completed)`; use incomplete when inventory or probes remain thin.
