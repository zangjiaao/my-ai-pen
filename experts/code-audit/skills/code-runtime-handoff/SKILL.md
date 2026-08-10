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
3. Book dumps/paths as **evidence** on the Case so the next expert’s context can see them.
4. **Seat change** to application security (`pentest`) or **llm-security**: **no silent seat switch** — `platform_list_experts` → one `request_user_decision(kind=handoff, …)` and wait. Never invent experts.
5. **Chat suggest only** when you are **not** requesting a seat change (note for user / Case context).

## Do not
- Start live exploitation inside code-audit without RoE.
- Drop static candidates without booking or a clear handoff/suggest path + evidence.
