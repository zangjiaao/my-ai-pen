---
name: file-inclusion
description: Use when a request contains page, file, path, template, include, download, or view parameters that may select server-side files or paths.
---

# File Inclusion And Path Traversal

Compare normal file selection with a controlled traversal or include attempt.

1. Capture the normal request and expected response.
2. Look up `poc(action="get", vuln_class="file-inclusion")`.
3. Use `http` or `verifier` to try low-impact local file markers and traversal variants.
4. Include a negative control such as a nonexistent path.
5. Confirm only when the response contains server-side file content or include behavior not reachable through intended choices.
6. Mark coverage for `(endpoint, param, file-inclusion)`.

Do not read secrets unless the task explicitly authorizes that level of proof.
