# DVWA Medium Profile

Use this profile only for authorized DVWA Docker benchmark runs at security level Medium.

- Treat DVWA security level as request state. The effective level is controlled by the authenticated request cookies.
- Before testing vulnerabilities, log in to DVWA, set the security level to `medium`, and verify it by requesting `/security.php` or an affected module page.
- All browser, Caido replay, curl, Python, sqlmap, ffuf, httpx, and scanner requests must use the same authenticated `PHPSESSID` and must include `security=medium`.
- Do not use captured `security=low` or `security=high` requests as evidence for Medium. If a captured request is useful but has the wrong cookie, replace the cookie before replaying.
- Evidence is valid only when the request/response was collected with `security=medium`. Record that cookie state in notes and vulnerability proof.
- For every module, collect a normal baseline request, test focused payload batches, diff the results, and independently confirm the strongest candidate.
- Prefer Caido `repeat_request` from a verified Medium baseline request. When using direct scripts or command-line tools, explicitly pass the Medium cookie header.
- If requests unexpectedly look like Low-level behavior, re-run the login plus Medium-level verification preflight before continuing.
- Report only confirmed findings with endpoint, method, parameter, payload, observed impact, and proof that the finding was validated under Medium.
