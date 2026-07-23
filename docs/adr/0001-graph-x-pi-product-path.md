# ADR 0001: Graph × Pi as product Node path

## Status

Accepted (2026-07-23)

## Context

The product needs Expert work (especially pentest) under enforceable process discipline (stages, Feedback gates, tool profiles), while Default remains a light workbench seat. Two candidates existed pre-decision:

- **Node4 lineage**: TypeScript, pi Agent Runtime, platform WS citizen, soft scenario graphs
- **Node5**: Python Google ADK hard Workflow lab arm, CLI-only, no platform citizen

Research (wayfinder map #8, tickets #9–#12) showed: Node can host Node5’s *model* without a Python product process; Graph × Pi is coherent only with **ownership inversion** (outer Graph schedules; pi is in-node); elevating Node5 is a finite platform-adapter cost but dual-language ops and missing Default.

## Decision

1. **Product kernel direction: Graph × Pi** on the Node4 lineage.
2. **Hard Graph** is product-owned (ordered stages + fail-closed Feedback), not soft scenario menus and not a requirement to ship ADK Python `Workflow`.
3. **pi** remains the in-node Agent Runtime for Expert stages.
4. **Default** never enters Expert Hard Graph.
5. **Node5** is frozen for productization: lab + semantic reference until hard triggers fire.
6. **Fallback B** (elevate pure Node5) only on documented hard triggers (ownership inversion fails; Feedback cannot fail-close on pi I/O; A cost ≫ ~2× B; pi blocked and C rejected; explicit ADK Py Workflow engine fidelity required).
7. **Exit ramp C** (Graph × ADK-TS) allowed for pi-only pain before jumping to B.

## Consequences

- Soft scenario Graph remains available but is **not** Hard Graph DoD.
- First-cut implementation: thin hard path `app_assessment_thin`, Hard Graph runner, pi stage executor, session-runner ownership inversion when `graphDiscipline=hard` / hard graph id / `NODE4_HARD_GRAPH`.
- Living docs describe A in pursuit / B on standby — not co-equal product kernels.
- Multi-expert packs share the same base; CTF/audit full Hard Graphs are later waves.

## References

- Spec #15, tickets #16–#22
- Wayfinder #8, path lock #13, decision package #14
