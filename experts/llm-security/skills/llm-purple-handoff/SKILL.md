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
2. Structured handoff to **alert-triage** for gap analysis / purple replay.
3. Classic Web/API on same asset → handoff to **application security** (`pentest`).
4. Static-only repo questions → **code-audit**.

## Do not
- Silent pack switch; invent detections; expand post-ex without structured RoE.
