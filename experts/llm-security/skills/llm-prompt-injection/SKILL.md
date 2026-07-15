---
name: llm-prompt-injection
description: Single-turn and encoded injection probes against authorized LLM/agent endpoints.
---

# Prompt injection

## Process
1. Establish baseline system behavior with benign prompts.
2. Probe for instruction override, system/prompt leakage, and policy bypass with clear success criteria.
3. Capture full model outputs as evidence.
4. Book only when the model demonstrates the unsafe behavior, not when it merely refuses.

## Do not
- Use illegal content requests outside RoE.
- Claim success without quoting proving model output in evidence.
