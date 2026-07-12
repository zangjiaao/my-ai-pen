---
name: auth-session
description: Use when the task involves login, cookies, session capture, authenticated replay, logout, password change, role context, or preserving browser state for HTTP verification.
---

# Authentication And Session Handling

Treat session state as test infrastructure.

1. Use `browser` for login when credentials are available (or `http` for API login).
2. Immediately call `browser(action="snapshot")` and/or `traffic` snapshot, then **`actor(action='capture', id=...)`** so the identity is named and reusable.
3. For multi-user apps, repeat login/registration for a **second actor** with a different id; never overwrite the first actor's store entry.
4. Replay authenticated requests with `http(actor=...)` or the active actor after `actor(activate)`.
5. Track when actions change the session, security level, token, or user role; re-capture the affected actor.
6. Record blockers explicitly when credentials, MFA, CSRF tokens, or account roles prevent multi-actor testing.

Do not guess authenticated endpoints without first collecting real traffic when browser access is possible.
Do not treat a single global cookie jar as sufficient for privilege testing.

## Credential walls (login / captcha / admin)

When a path is gated by authentication, treat **credential discovery** as an explicit sub-goal before declaring the path blocked:

1. Look for in-app registration, invite, demo accounts, password-reset, or credentials revealed by other authorized tests (API docs, dumps) when in scope.
2. Capture sessions with `actor(capture)` after any successful login/register.
3. Only after those paths are tried (or proven unavailable) may you mark the gated surface blocked for missing credentials.
4. Proving a captcha does not refresh / is weak / leaks is not the same as completing an authenticated objective — keep the credential step open or blocked with notes.

Put credential work in its own plan step or worker package when packages are split.
