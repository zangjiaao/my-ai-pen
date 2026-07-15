---
name: alert-harm-severity
description: Rank impact with exploitability, blast radius, autonomy, and recoverability.
---

# Harm severity & triage

Adapted from AI-Red-Teaming-Guide AI Harm Severity model (usable for classic + AI alerts).

## When to load
- Ranking multiple alerts or red findings for response priority
- Agent/tool abuse where CVSS alone understates autonomy risk

## Dimensions (Low → Critical as applicable)
| Dimension | Ask |
|-----------|-----|
| **Exploitability** | How easy to reproduce? |
| **User impact** | Harm to users / data / integrity? |
| **Autonomy** | Actions without human confirmation? (None/Partial/Full) |
| **Blast radius** | Single user · tenant · cross-tenant / system-wide |
| **Recoverability** | Easy / moderate / hard to restore safe state |

## Suggested response urgency (guidance, not product SLA hardcode)
- **Critical**: autonomous unsafe tool action or cross-tenant leak → immediate contain/page path
- **High**: reliable exploit family in prod → disable flow / hotfix track
- **Medium**: narrow single-user policy hit → standard ticket
- **Low**: backlog with review date

## Do not
- Rank by alert name string alone.
- Invent regulatory reporting — note only if customer policy requires escalation.
