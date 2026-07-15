# AI red-team RoE checklist (recipe)

Adapted from `research/AI-Red-Teaming-Guide/templates/rules-of-engagement-template.md` — fill during engagement setup; not an answer key.

## Scope
- [ ] In-scope systems / endpoints / tenants
- [ ] Out of scope (prod data classes, third parties)
- [ ] Access level: black / gray / white box

## Authorized techniques
- [ ] Allowed: prompt probes, multi-turn, encoding, tool abuse in lab sinks
- [ ] Prohibited: (list)

## Safety
- [ ] No production data export
- [ ] Rate limits / concurrency caps
- [ ] Stop conditions (critical finding, customer request)

## Contacts
- [ ] Security contact / escalation SLA
- [ ] Legal/compliance for high-risk domains

## Evidence retention
- [ ] What is stored (transcripts, tool logs)
- [ ] Retention / deletion procedure
