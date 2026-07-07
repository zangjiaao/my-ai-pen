# DVWA High Profile

Use this profile only for authorized DVWA Docker benchmark runs at security level High.

- Treat DVWA security level as request state, not an environment guarantee. The effective level is controlled by the authenticated request cookies.
- Before testing vulnerabilities, log in to DVWA, set the security level to `high`, and verify it by requesting `/security.php` or an affected module page.
- All browser, Caido replay, curl, Python, sqlmap, ffuf, httpx, and scanner requests must use the same authenticated `PHPSESSID` and must include `security=high`.
- Do not use any captured request with `security=low` or `security=medium` as a baseline. If a useful captured request has the wrong cookie, replace the cookie before replaying it.
- Evidence is valid only when the request/response was collected with `security=high`. Record that cookie state in notes and vulnerability proof.
- For every module, first collect a normal baseline request, then run targeted payload tests, then independently confirm the strongest candidate.
- High level often changes tokens, filters, or workflow requirements. Refresh CSRF/user tokens from the current page before submitting forms instead of replaying stale tokens.
- Prefer Caido `repeat_request` from a verified High baseline request. When using direct scripts or command-line tools, explicitly pass the High cookie header.
- If the cookie jar or browser session becomes uncertain, stop testing and re-run the login plus High-level verification preflight.
- Report only confirmed findings with endpoint, method, parameter, payload, observed impact, and proof that the finding was validated under High.
