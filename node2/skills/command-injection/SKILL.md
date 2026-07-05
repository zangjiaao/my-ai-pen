---
name: command-injection
description: Use when an endpoint executes network, diagnostic, conversion, or admin operations with user-controlled host, ip, domain, command, filename, or option values.
---

# Command Injection

Prove command execution with a harmless, scoped effect.

1. Capture a baseline request and response with `http` or `traffic`.
2. Look up `poc(action="get", vuln_class="command-injection")` for payload families and evidence gates.
3. Use `verifier` for common command-injection checks when the endpoint and parameter are known.
4. Prefer harmless read-only commands or short timing checks; do not create shells or persistent files.
5. Confirm only when response output, timing, or another controlled side channel proves server-side command execution.
6. Mark coverage for each tested `(endpoint, param, command-injection)` tuple.

A validation error, HTTP 200, or reflected payload is not confirmation.
