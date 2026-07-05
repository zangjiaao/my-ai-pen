---
name: access-control
description: Use when object IDs, user IDs, tenant IDs, roles, admin functions, direct file/API access, or authenticated endpoints may lack server-side authorization checks.
---

# Access Control And IDOR

Compare authorization contexts.

1. Capture an authorized baseline request.
2. Look up `poc(action="get", vuln_class="access-control")`.
3. Replay the same request unauthenticated, with a lower-privilege session, or with a different owned test object.
4. Record account/role context for each request.
5. Confirm only when unauthorized access to data or actions is proven with evidence.
6. Mark coverage for the tested endpoint, object parameter, and `access-control`.

Use test accounts and avoid accessing third-party data.
