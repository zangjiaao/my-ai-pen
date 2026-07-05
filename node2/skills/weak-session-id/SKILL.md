---
name: weak-session-id
description: Use when session identifiers, reset tokens, challenge IDs, or application-issued cookies appear sequential, short, low variance, or otherwise predictable.
---

# Weak Session ID

Collect enough samples before claiming predictability.

1. Identify the token source and how it is issued.
2. Look up `poc(action="get", vuln_class="weak-session-id")`.
3. Generate multiple samples using `http`, `browser`, `verifier`, or a bounded `poc` script.
4. Analyze sequence, length, charset, timestamp dependence, and variance.
5. Confirm only when the samples support a predictable or low-entropy pattern.
6. Mark coverage for `(endpoint, session, weak-session-id)`.

Do not hijack or guess real user sessions.
