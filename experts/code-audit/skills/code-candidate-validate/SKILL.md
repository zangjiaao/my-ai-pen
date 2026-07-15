---
name: code-candidate-validate
description: Adversarial second pass — try to refute a candidate before booking.
---

# Candidate validate

Adapted from Argo adversarial validation: assume false positive until evidence forces confirmation.

## When to load
- Before booking medium+ severity static findings
- After a focus review produced candidates

## Process (try to break each link)
1. **Reachability** — path from attacker entry to sink; dead/internal-only → refute or downgrade.
2. **Attacker control** — untrusted input vs constant/server-derived.
3. **Sanitization/encoding** — real mitigation on path (framework defaults count).
4. **Sink reality** — is the sink dangerous in *this* context?
5. **Authz elsewhere** — missing check truly absent, or enforced in filter/service/middleware?
6. **Preconditions & severity honesty** — unrealistic preconditions → downgrade.

## Verdict
- `confirmed` — book with surviving data flow + excerpts
- `refuted` — drop or note as non-issue
- `needs_runtime_verification` — hand off via `code-runtime-handoff`
- `out_of_scope` — do not book

## Do not
- Contact live hosts in this skill.
- Patch code or weaken the claim to “kind of” true — judge as written, then restate if confirmed.
- Replace discovery: only follow **existing** candidates.
