---
name: llm-threat-model-roe
description: Plan AI red-team scope, threat model, and RoE before deep probing (authorized engagements only).
---

# Threat model & RoE (AI systems)

Adapted from AI-Red-Teaming-Guide planning methodology and RoE templates.

## When to load
- Start of an LLM/Agent engagement
- Scope or access level changed

## Process
1. **Define system under test:** chat model only, RAG, tool agent, multi-agent, computer-use.
2. **Access level:** black box (API/UI only) / gray (partial arch) / white (code/weights) — document it.
3. **Assets:** PII, secrets, tools, tenants, reputation, safety policy.
4. **Adversaries:** external user, malicious document/URL, compromised tool server, insider.
5. **Abuse paths (short list):** prioritize by impact × likelihood; map tags optionally to OWASP GenAI/Agentic themes for reporting.
6. **RoE checklist:** in/out of scope; banned techniques; rate limits; stop conditions; no production data export; escalation contacts.
7. Coarse todo by category (injection, jailbreak, leakage, tools, RAG, multi-agent) — not one todo per test-case ID.

## Outputs
- Written scope notes in workspace
- Prioritized 3–8 abuse paths to drive probes

## Do not
- Invent offline product-specific exploit catalogs.
- Expand beyond written authorization.
