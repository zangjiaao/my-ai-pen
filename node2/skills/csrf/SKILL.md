---
name: csrf
description: Use when a state-changing action depends only on ambient cookies or has missing, static, stale, or weakly bound CSRF tokens.
---

# CSRF

Prove a state change, not merely the absence of a token field.

1. Capture the state before the action.
2. Capture the normal state-changing request with `browser` and `traffic`.
3. Look up `poc(action="get", vuln_class="csrf")`.
4. Replay without token, with a stale token, or as a simple cross-site form model as appropriate.
5. Capture the state after the request and restore it when possible.
6. Confirm only with before/request/after evidence and token binding analysis.

Use reversible test-account changes only.
