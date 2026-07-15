---
name: llm-agent-tool-abuse
description: Tool orchestration abuse, excessive agency, and goal redirection on tool-calling agents.
---

# Agent tool abuse

## Process
1. Inventory tools/schemas the agent exposes (from docs or live observation).
2. Hypothesize unsafe tool sequences or permission escalations.
3. Prove with tool-call results and side effects in scope.
4. Book with tool names, sequence, and outcome evidence.

## Do not
- Attack external systems outside authorized scope via the agent.
