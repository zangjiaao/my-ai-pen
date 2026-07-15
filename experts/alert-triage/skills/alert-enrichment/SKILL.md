---
name: alert-enrichment
description: Enrich alerts with asset, identity, timeline, and related Case artifacts.
---

# Alert enrichment

## When to load
- New alert or queue item before verdict
- Handoff package arrived with partial context

## Process
1. Normalize fields: source, rule/id, severity, entities (host, user, tenant, agent id, tool name).
2. Attach related logs and Case artifacts (red-team finding ids, transcripts, evidence paths) when available.
3. Build a short **timeline** (first seen → last → related events).
4. For AI/agent systems, pull **action telemetry** if present (tool calls, egress, memory writes) — not prompt text alone.
5. Note missing context as open questions, not guesses.

## Outputs
- Enriched summary ready for TP/FP or gap analysis

## Do not
- Attack production to fill gaps without authorization.
