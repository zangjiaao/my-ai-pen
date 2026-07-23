# ADR 0001: Graph × Pi as product Node path

## Status

Accepted (2026-07-23)  
**Amended (2026-07-24)** — Runtime package boundary (Wayfinder map [#37](https://github.com/zangjiaao/my-ai-pen/issues/37); construction spec [#47](https://github.com/zangjiaao/my-ai-pen/issues/47)).

## Context

The product needs Expert work (especially pentest) under enforceable process discipline (stages, Feedback gates, tool profiles), while Default remains a light workbench seat. Two candidates existed pre-decision:

- **Node4 lineage**: TypeScript, pi Agent Runtime, platform WS citizen, soft scenario graphs
- **Node5**: Python Google ADK hard Workflow lab arm, CLI-only, no platform citizen

Research (wayfinder map #8, tickets #9–#12) showed: Node can host Node5’s *model* without a Python product process; Graph × Pi is coherent only with **ownership inversion** (outer Graph schedules; pi is in-node); elevating Node5 is a finite platform-adapter cost but dual-language ops and missing Default.

Later research (map #37) showed Node4 used **pi-coding-agent** only as a session SDK (`createAgentSession`), with product tools and skills already owned by Node4, while Pi’s own layering (pi-ai / pi-agent-core / pi-tui / pi-coding-agent) makes coding-agent an opinionated coding product shell—not the required Runtime. Core-only Runtime (pi-ai + pi-agent-core) is feasible with thin Node4 glue.

## Decision

1. **Product kernel direction: Graph × Pi** on the Node4 lineage.
2. **Hard Graph** is product-owned (ordered stages + fail-closed Feedback), not soft scenario menus and not a requirement to ship ADK Python `Workflow`.
3. **Agent Runtime** for Expert stages (and Default seat loops) is **pi-ai + pi-agent-core** via product seam **`runNode4Agent`**: stateful **Agent**, **AgentTool**, events/hooks. This is what “pi” means in Graph × Pi — **not** the pi-coding-agent product shell.
4. **Default** never enters Expert Hard Graph.
5. **Node5** is frozen for productization: lab + semantic reference until hard triggers fire.
6. **Fallback B** (elevate pure Node5) only on documented hard triggers (ownership inversion fails; Feedback cannot fail-close on Runtime I/O; A cost ≫ ~2× B; Runtime blocked and C rejected; explicit ADK Py Workflow engine fidelity required). **Package-strip pain alone does not trigger B.**
7. **Exit ramp C** (Graph × ADK-TS or other Runtime swap) allowed when the Agent / pi-ai contract itself is inadequate or cost ≫ swapping Runtime — after any temporary migration buffer — before jumping to B.
8. **Runtime packages (product, steady state):** allow **pi-ai** and **pi-agent-core** only among Pi packages; **forbid pi-coding-agent** in product runtime dependencies, production imports, and tests. Package **source** (vendored tree vs npm registry) is a construction detail.
9. **Runtime API allow:** Agent (primary), AgentTool, beforeToolCall/afterToolCall, AgentEvent subscribe, optional transformContext/convertToLlm; pi-ai models/stream/abort. **Deny as product Runtime:** AgentHarness, session JSONL/memory repos as product SOT, core skills/prompt-template loaders, NodeExecutionEnv as product shell. Thin Node4 glue only — do not re-grow a coding-agent-equivalent shell.
10. **Product state is SOT:** multi-actor session jars, Hard Graph handoff/continuity (parent lifecycle, surface ledger, structured stage results), findings/booking, Feedback/settlement inputs. **Runtime transcript** is subordinate (ephemeral; optional Node4 event projection). Platform observability via **event bridge** from Runtime events. Gates must not parse private Runtime/coding-agent session formats.
11. **pi-tui** is **not** part of the product Runtime contract; optional standalone CLI UI later only.
12. **Strip / migration exits:** temporary re-introduction of coding-agent only under kill-switch (flag default off + owner + expiry/milestone), session-glue scope only; then Exit C if still blocked by Agent/pi-ai inadequacy. Expired kill-switch left on is construction debt, not policy.

## Consequences

- Soft scenario Graph remains available but is **not** Hard Graph DoD.
- First-cut implementation: thin hard path `app_assessment_thin`, Hard Graph runner, pi stage executor, session-runner ownership inversion when `graphDiscipline=hard` / hard graph id / `NODE4_HARD_GRAPH`.
- Living docs describe A in pursuit / B on standby — not co-equal product kernels.
- Multi-expert packs share the same base; CTF/audit full Hard Graphs are later waves.
- Construction: Main / subagent / Hard Graph stages enter via `runNode4Agent`; tools as AgentTool; no coding-agent dependency.
- `CONTEXT.md` terms: Product state (SOT), Runtime transcript, Agent Runtime package/API boundary.

## References

- Spec #15, tickets #16–#22
- Wayfinder #8, path lock #13, decision package #14
- Wayfinder map #37 (Pi runtime package boundary), tickets #38–#44
- Construction spec #47
- `docs/wayfinder/node4-pi-coding-agent-surface.md`
- `docs/wayfinder/pi-ai-agent-core-runtime-contract.md`
