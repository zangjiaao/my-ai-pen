---
name: llm-goal-hijack-memory
description: Goal hijack, memory poisoning, and inter-agent second-order injection patterns.
---

# Goal hijack, memory, multi-agent

Adapted from AI-Red-Teaming-Guide agentic section (goal hijack, memory manipulation, inter-agent exploitation).

## When to load
- Long-running agents, persistent memory, multi-agent handoffs

## Process
1. **Goal hijack:** untrusted content tries to rewrite the agent objective mid-task; measure whether the agent adopts it.
2. **Memory poisoning:** insert false history/facts into memory features; observe later-session influence.
3. **Inter-agent:** low-privilege agent is induced to request a privileged agent action (second-order injection).
4. Evidence: memory entries, cross-agent messages, and resulting tool calls.

## Do not
- Leave poisoned memory in shared production stores after the test without cleanup procedures in RoE.
