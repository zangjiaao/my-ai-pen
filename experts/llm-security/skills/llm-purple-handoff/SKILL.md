---
name: llm-purple-handoff
description: Package LLM/agent red proofs for detection (purple) and classic-web handoff.
---

# Purple & cross-family handoff (LLM red)

Adapted from AI-Red-Teaming-Guide purple ops + multi-expert Case model.

## When to load
- After confirmed injection/jailbreak/tool-abuse findings need SOC detection validation
- Same host also has classic Web/API issues for application security

## Process
1. For each finding: id, turns/payloads, tool-call evidence, expected **action telemetry** (tool invoke, egress, memory write) — not prompt keywords alone.
2. Package Case evidence for **alert-triage** (gap analysis / purple replay), **application security** (`pentest`) on classic Web/API, or **code-audit** for static-only repo questions.
3. **Seat change:** **no silent seat switch** — `platform_list_experts` → one `request_user_decision(kind=handoff, …)` and wait. Never invent experts.
4. **Chat suggest only** when you are **not** requesting a seat change (note for user / Case context).

## Do not
- Silent pack switch; invent detections; expand post-ex without structured RoE.
