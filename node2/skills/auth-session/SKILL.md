---
name: auth-session
description: Use when the task involves login, cookies, session capture, authenticated replay, logout, password change, role context, or preserving browser state for HTTP verification.
---

# Authentication And Session Handling

Treat session state as test infrastructure.

1. Use `browser` for login when credentials are available.
2. Immediately call `browser(action="snapshot")` and `traffic(action="snapshot")` to preserve cookies and storage.
3. Replay authenticated requests with `http` only after carrying the relevant cookies/headers.
4. Track when actions change the session, security level, token, or user role.
5. Record blockers explicitly when credentials, MFA, CSRF tokens, or account roles prevent testing.

Do not guess authenticated endpoints without first collecting real traffic when browser access is possible.
