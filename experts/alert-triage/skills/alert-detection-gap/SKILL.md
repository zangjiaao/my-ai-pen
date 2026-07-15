---
name: alert-detection-gap
description: Purple-team check — did detections fire for a known red-team proof?
---

# Detection gap

Adapted from AI-Red-Teaming-Guide purple outputs (detection specs linked to finding IDs).

## When to load
- Case contains a proven finding/PoC from red (pentest / llm-security)
- Customer asks “would we have caught this?”

## Process
1. Identify the red finding id, time window, and expected signals (HTTP anomaly, tool call, egress, auth failure burst, policy violation log).
2. Search available alerts/logs for matches in that window.
3. If none: document **gap** — expected detection signal, suggested telemetry source, link to finding id.
4. If partial: document what fired and what was missed (e.g. prompt content only, not tool action).
5. Prefer detections on **agent actions** (tool/MCP/network) over keyword-on-prompt alone when the system is agentic.

## Outputs
- Gap note bookable as finding or structured note with evidence of absence (query + empty result window)

## Do not
- Invent alerts that never fired.
- Treat absence of SIEM access as “no gap” without saying data was unavailable.
