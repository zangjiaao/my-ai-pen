---
name: code-focus-review
description: Deep review of one focus area with source→sink file-level evidence.
---

# Focus review

## When to load
- After recon/partition selected one focus (e.g. authz, SQLi sinks, SSRF, secrets)

## Process
1. Stay inside the chosen focus; do not wander the whole repo.
2. Trace **attacker-controlled input → dangerous sink** with concrete `file:line` at each hop you can show.
3. Note framework defaults that might mitigate (parameterized queries, auto-escape, middleware).
4. Prefer **one strong proven issue** over many speculative notes.
5. Record candidates with: location, data flow summary, preconditions, proposed severity.

## Outputs
- Candidate notes (not booked yet if high severity — run validate first)

## Do not
- Book Critical/High without either strong static chain or planned validate/handoff.
- Use a fixed vulnerability checklist as product truth.
