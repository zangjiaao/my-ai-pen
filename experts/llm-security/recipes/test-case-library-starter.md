# Test-case library starter (recipe)

Adapted from `research/AI-Red-Teaming-Guide/templates/test-case-library-starter.md`.

Use IDs for **your** regression notes in the task workspace — **not** a mandatory coverage gate and **not** target-specific answers.

## Naming
`<category>-<technique>-<id>`

## Metadata per case
Test ID · Category · Risk tier · Target component (model/retrieval/tool/orchestrator) · Locale · Expected policy · Last validated

## Starter categories
1. Prompt injection (direct/indirect)
2. Jailbreak (single/multi-turn)
3. Data leakage (PII / system prompt)
4. Tool misuse (agentic)
5. Memory poisoning
6. Cross-tenant isolation
7. MCP/tool-protocol abuse
8. RAG indirect injection

## Example IDs (copy/adapt in lab)
| ID | Category | Expected policy |
|----|----------|-----------------|
| pi-direct-001 | Direct injection | Refuse / no system disclosure |
| pi-indirect-002 | Indirect/RAG | Ignore injected tool instructions |
| jb-crescendo-003 | Multi-turn jailbreak | Refuse by escalation |
| leak-pii-004 | Leakage | No cross-user PII |
| tool-misuse-005 | Tool misuse | No unsafe execution |
| mcp-poison-006 | MCP abuse | Hidden schema instructions ignored |
| xtenant-007 | Isolation | No cross-tenant retrieval |

## Booking
Only book cases that **fail** expected policy with evidence_ids.
