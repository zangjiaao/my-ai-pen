# ADR 0001: Graph × Pi as product Node path

## Status

Accepted (2026-07-23)  
**Amended (2026-07-24)** — Runtime package boundary (Wayfinder map [#37](https://github.com/zangjiaao/my-ai-pen/issues/37); construction spec [#47](https://github.com/zangjiaao/my-ai-pen/issues/47)).  
**Amended (2026-07-24)** — **B1 retire fallback B** + **X1 hard-delete `node5/`** (Wayfinder map [#59](https://github.com/zangjiaao/my-ai-pen/issues/59); task [#67](https://github.com/zangjiaao/my-ai-pen/issues/67)). Hard Graph Node4 reached P1 scorecard parity vs Node5 lab on Juice + DVWA; product unique Node lineage = **Node4 Hard Graph × Pi**. Exit C remains.  
**Amended (2026-08-26)** — Graph entry is **pack-declared graph ids + user permission** for every Expert, including built-in `default`. No Default-vs-Expert caste; `default` currently declares no Graphs. Aligns Spec [#277](https://github.com/zangjiaao/my-ai-pen/issues/277) Graph capability tables. Decision 4 below is superseded.

## Context

The product needs Expert work (especially pentest) under enforceable process discipline (stages, Feedback gates, tool profiles), while Default remains a light workbench seat. Two candidates existed pre-decision:

- **Node4 lineage**: TypeScript, pi Agent Runtime, platform WS citizen, soft scenario graphs
- **Node5**: Python Google ADK hard Workflow lab arm, CLI-only, no platform citizen

Research (wayfinder map #8, tickets #9–#12) showed: Node can host Node5’s *model* without a Python product process; Graph × Pi is coherent only with **ownership inversion** (outer Graph schedules; pi is in-node); elevating Node5 is a finite platform-adapter cost but dual-language ops and missing Default.

Later research (map #37) showed Node4 used **pi-coding-agent** only as a session SDK (`createAgentSession`), with product tools and skills already owned by Node4, while Pi’s own layering (pi-ai / pi-agent-core / pi-tui / pi-coding-agent) makes coding-agent an opinionated coding product shell—not the required Runtime. Core-only Runtime (pi-ai + pi-agent-core) is feasible with thin Node4 glue.

Map [#59](https://github.com/zangjiaao/my-ai-pen/issues/59) ran offline P1 parity (Hard Graph Node4 vs Node5 lab) on Juice Shop + DVWA. After mature Hard Graph work and dual-target P1 pass, **fallback B (elevate pure Node5) is retired** and the **`node5/` tree is hard-deleted** from the product repo. Historical dual-arm scorecards remain under `benchmarks/hard-vs-node5/` (frozen lab evidence, not a live runtime).

## Decision

1. **Product kernel direction: Graph × Pi** on the Node4 lineage.
2. **Hard Graph** is product-owned (ordered stages + fail-closed Feedback), not soft scenario menus and not a requirement to ship ADK Python `Workflow`.
3. **Agent Runtime** for Expert stages (and Default seat loops) is **pi-ai + pi-agent-core** via product seam **`runNode4Agent`**: stateful **Agent**, **AgentTool**, events/hooks. This is what “pi” means in Graph × Pi — **not** the pi-coding-agent product shell.
4. **Superseded (2026-08-26):** Graph entry is not a Default-vs-Expert caste. Every Expert pack (including built-in `default`) enters Hard Graph only when **that pack declares graph ids** and the user permits. Built-in `default` currently declares none (ledger assist); adding `graphs/hard/*` later uses the same rule. Do not hard-code “assistant never Graph.”
5. **Unique product Node lineage = Node4** (`node4/`). There is **no** co-equal product kernel and **no** live `node5/` tree. Task / Agent / Feedback three-layer semantics live in product Hard Graph docs (`docs/specs/task-graph.md`); git history holds the former Node5 lab source if archaeology is needed.
6. **Fallback B retired (B1).** Elevating pure Node5 as product Node is **not** a standing exit. Do not reintroduce a Python ADK product process or treat historical Node5 as a bindable candidate.
7. **Exit ramp C** (Graph × ADK-TS or other Runtime swap) remains when the Agent / pi-ai contract itself is inadequate or cost ≫ swapping Runtime — after any temporary migration buffer. C is a **Runtime swap under Graph ownership**, not “ship Node5.”
8. **Runtime packages (product, steady state):** allow **pi-ai** and **pi-agent-core** only among Pi packages; **forbid pi-coding-agent** in product runtime dependencies, production imports, and tests. Package **source** (vendored tree vs npm registry) is a construction detail.
9. **Runtime API allow:** Agent (primary), AgentTool, beforeToolCall/afterToolCall, AgentEvent subscribe, optional transformContext/convertToLlm; pi-ai models/stream/abort. **Deny as product Runtime:** AgentHarness, session JSONL/memory repos as product SOT, core skills/prompt-template loaders, NodeExecutionEnv as product shell. Thin Node4 glue only — do not re-grow a coding-agent-equivalent shell.
10. **Product state is SOT:** multi-actor session jars, Hard Graph handoff/continuity (parent lifecycle, surface ledger, structured stage results), findings/booking, Feedback/settlement inputs. **Runtime transcript** is subordinate (ephemeral; optional Node4 event projection). Platform observability via **event bridge** from Runtime events. Gates must not parse private Runtime/coding-agent session formats.
11. **pi-tui** is **not** part of the product Runtime contract; optional standalone CLI UI later only.
12. **Strip / migration exits:** temporary re-introduction of coding-agent only under kill-switch (flag default off + owner + expiry/milestone), session-glue scope only; then Exit C if still blocked by Agent/pi-ai inadequacy. Expired kill-switch left on is construction debt, not policy.

## Consequences

- Soft scenario Graph is **retired as a product work mode** (#68 / #76). Structured work uses the Hard Graph runner when the pack declares graphs and the user permits. Packs without declared graphs stay Free (built-in `default` today).
- Expert Graph path: mature hard graph primary (`graphs/hard/app_assessment.json`); thin lab alias only; product template `app_assessment` resolves to Expert Graph; Hard Graph runner + pi stage executor.
- Living docs describe **one** product Node lineage (Node4) — not co-equal kernels, not “A in pursuit / B on standby.”
- Multi-expert packs share the same base; CTF/audit full Hard Graphs are later waves.
- Construction: Main / subagent / Hard Graph stages enter via `runNode4Agent`; tools as AgentTool; no coding-agent dependency.
- `CONTEXT.md` terms: Product state (SOT), Runtime transcript, Agent Runtime package/API boundary; Node candidate = Node4 lineage only.
- Frozen P1 evidence: `benchmarks/hard-vs-node5/` (historical). Do not resurrect `node5/` as product without a new ADR.

## References

- Spec #15, tickets #16–#22
- Wayfinder #8, path lock #13, decision package #14
- Wayfinder map #37 (Pi runtime package boundary), tickets #38–#44
- Construction spec #47
- Wayfinder map #59 (Hard Node4 P1 vs Node5 → delete Node5), task #67 (X1 + B1)
- `docs/wayfinder/node4-pi-coding-agent-surface.md`
- `docs/wayfinder/pi-ai-agent-core-runtime-contract.md`
