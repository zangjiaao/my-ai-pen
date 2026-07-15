---
name: code-runtime-handoff
description: Package static candidates for structured handoff to runtime (application security).
---

# Runtime handoff

## When to load
- Verdict is `needs_runtime_verification`
- Customer wants dynamic proof of a static chain

## Process
1. Collect for each candidate: location, data flow, PoC idea, accounts/roles needed, out-of-scope constraints.
2. Write a short handoff note in workspace (artifact path for Case handoff).
3. Use **structured Case handoff** to application security (`pentest`) — do not silently switch pack mid-run.
4. If the defect is agent/LLM-specific behavior, hand off to **llm-security** instead/additionally.
5. After runtime proof exists in the case, detection gaps may go to **alert-triage** (purple).

## Do not
- Start live exploitation inside code-audit without RoE.
- Drop static candidates without either booking static-proof or recording handoff.
