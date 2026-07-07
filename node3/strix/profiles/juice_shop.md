# OWASP Juice Shop Profile

Use this profile only for authorized OWASP Juice Shop benchmark runs.

- Treat Juice Shop as a modern single-page application with browser workflows and JSON APIs. Map both UI routes and API endpoints before deep testing.
- Establish whether the run should be unauthenticated, authenticated as a normal user, or authenticated as an admin-like account. Keep those identities separate.
- Capture baseline traffic through Caido for registration/login, basket, product search, checkout, complaint/upload, profile, and admin-related workflows when available.
- For direct scripts and command-line tools, reuse the relevant authorization headers, cookies, and JSON content types from verified baseline requests.
- Prioritize confirmed business-impact findings: broken access control, IDOR, authentication/session issues, injection, XSS with executable proof, file upload abuse, sensitive data exposure, and API authorization flaws.
- Do not report challenge hints, scoreboard metadata, or intentionally exposed training text as vulnerabilities unless they demonstrate a concrete exploit path.
- Prefer API-level validation for repeatability, then use the browser only to confirm UI-visible impact when needed.
- Keep evidence tied to exact requests and responses. Include endpoint, method, parameter/body field, identity used, payload, and observed impact.
- For benchmark runs, avoid destructive cart/order/profile changes unless they are necessary to validate a finding and are scoped to the disposable test environment.
