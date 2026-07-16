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
3. In chat, **suggest** application security (`pentest`) continue — do not silently switch pack mid-run.
4. If the defect is agent/LLM-specific, suggest **llm-security** instead/additionally.
5. Book dumps/paths as **evidence** on the Case so the next expert’s context can see them.

## Do not
- Start live exploitation inside code-audit without RoE.
- Drop static candidates without booking or a clear chat suggestion + evidence.
