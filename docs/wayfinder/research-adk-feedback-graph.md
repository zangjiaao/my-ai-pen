# Research: Google ADK Feedback Graph (or equivalents)

## Executive answer

**No first-class product term “Feedback Graph” exists in Google ADK docs or APIs.**  
Closest equivalents: **`LoopAgent`** (template workflow), **Iterative refinement / Generate-and-review** patterns, and **graph back-edges** (`Workflow` / graph engine with critic → refine → critic).

**Runtime orchestration is hybrid:**

| Layer | Nature |
| --- | --- |
| **Workflow control** (`SequentialAgent` / `ParallelAgent` / `LoopAgent`, or ADK 2.0 graph edges) | **Deterministic** — not LLM-orchestrated for which step runs next |
| **Quality judgment inside the loop** (Critic / QualityChecker `LlmAgent`) | **Agentic LLM judge** — pass/fail, feedback text, completion phrases |
| **Loop exit** | **Hybrid hard gates**: `max_iterations` and/or `escalate=True` / route `"DONE"` (often set after LLM verdict, or by deterministic code reading state) |
| **Offline `evaluate/` package** | **Separate** harness (exact trajectory match + ROUGE + LLM-as-judge criteria) — **not** an in-workflow “Feedback Graph” product primitive |

So: **not** a pure hard gate product; **not** a pure free-form agentic graph named Feedback Graph; **hybrid** — deterministic multi-agent graph/loop + optional LLM critic/revision + hard caps.

---

## Terminology (ADK names)

| Name | Role | Source |
| --- | --- | --- |
| **Template / workflow agents** | `SequentialAgent`, `LoopAgent`, `ParallelAgent` — fixed control flow, no model for orchestration | [adk.dev/agents/workflow-agents](https://adk.dev/agents/workflow-agents/) |
| **`LoopAgent`** | Runs `sub_agents` in order, repeatedly, until termination | [loop-agents](https://adk.dev/agents/workflow-agents/loop-agents/) |
| **Graph-based workflows** (`Workflow`, nodes, edges, routes) | ADK 2.0 (Python/Go): declarative node/edge graphs; supersedes templates for new flexible designs | [adk.dev/graphs](https://adk.dev/graphs/) |
| **Dynamic workflows** | Code-level loops/conditionals when static graphs are insufficient | [adk.dev/graphs](https://adk.dev/graphs/) |
| **Generate and review** | One-shot generator + critic in `SequentialAgent` | [patterns](https://adk.dev/workflows/patterns/) |
| **Iterative refinement** | `LoopAgent` + refiner + quality checker + escalate stop | [patterns § iterative refinement](https://adk.dev/workflows/patterns/#iterative-refinement) |
| **CriticAgent / QualityChecker** | Example `LlmAgent`s that critique or pass/fail | [loop-agents](https://adk.dev/agents/workflow-agents/loop-agents/), [patterns](https://adk.dev/workflows/patterns/) |
| **`escalate` / `exit_loop` tool** | Sub-agent or tool sets `EventActions.escalate` / `tool_context.actions.escalate = True` to end loop | [loop-agents](https://adk.dev/agents/workflow-agents/loop-agents/), [patterns](https://adk.dev/workflows/patterns/) |
| **`before_agent_callback` / `after_agent_callback`** | Lifecycle hooks on any `BaseAgent` (setup, skip, state checks) — not a feedback graph | [callbacks](https://adk.dev/callbacks/types-of-callbacks/) |
| **Evaluation / AgentEvaluator / criteria** | Offline test files & evalsets; trajectory + response metrics including LLM-as-judge | [evaluate](https://adk.dev/evaluate/), [criteria](https://adk.dev/evaluate/criteria/) |

**Not found as product names:** “Feedback Graph”, “FeedbackGraph”, dedicated Feedback agent type.

---

## Documented flows

### 1. Template workflow agents (prebuilt)

- Orchestration is **deterministic**: sequence, parallel, or loop logic is code-defined, not chosen by an LLM.  
  Source: [workflow-agents](https://adk.dev/agents/workflow-agents/), [sequential-agents](https://adk.dev/agents/workflow-agents/sequential-agents/).
- **`LoopAgent`**: iterates `sub_agents` in order; **does not inherently decide stop** — developer must supply **max iterations** and/or **escalation from a sub-agent**.  
  Source: [loop-agents](https://adk.dev/agents/workflow-agents/loop-agents/).
- Full **Writer → Critic → Refiner** example: `SequentialAgent([initial_writer, LoopAgent([critic, refiner], max_iterations=5)])`; critic emits completion phrase; refiner calls `exit_loop` which sets `escalate=True`.  
  Source: [loop-agents full example](https://adk.dev/agents/workflow-agents/loop-agents/).

### 2. Documented multi-agent patterns

- **Coordinator / dispatcher**: LLM-driven transfer among specialists.  
- **Sequential pipeline**: fixed order; shared session state via `output_key`.  
- **Parallel fan-out/gather**: concurrent sub-agents then synthesizer.  
- **Generate and review**: generator then reviewer (single pass; not a loop).  
- **Iterative refinement**: `LoopAgent([code_refiner, quality_checker, CheckStatusAndEscalate])`; stop when quality status is `"pass"` (`escalate=True`) or `max_iterations`.  
  Source: [workflows/patterns](https://adk.dev/workflows/patterns/).

### 3. Graph-based workflows (ADK 2.0)

- Graph of **nodes** (agents, tools, functions, human input) and **edges** with explicit routing (`Event(route=...)` / `Event.Routes`).  
  Source: [graphs](https://adk.dev/graphs/), [graphs/routes](https://adk.dev/graphs/routes/).
- **Loop-as-back-edge**: critic → router → `"REFINE"` → refiner → back to critic; `"DONE"` → terminal. Graph engine re-activates target node each iteration.  
  Source: [graphs/routes § loop and escalation exit](https://adk.dev/graphs/routes/#loop-and-escalation-exit).
- Prebuilt `loopagent` without graph engine: no `Event.Routes`; use state/`OutputKey` or **Escalate-based exit**.  
  Source: same page.

### 4. Offline evaluation (not runtime feedback graph)

- Trajectory vs expected tool path; final response quality; mix of **exact match**, **ROUGE**, and **LLM-as-a-Judge** criteria; thresholds for pass/fail of eval cases.  
  Source: [evaluate](https://adk.dev/evaluate/), [criteria](https://adk.dev/evaluate/criteria/).

---

## Quotes + evidence

**Workflow control is deterministic:**

> “Template workflow agents operate based on predefined logic. They determine the execution sequence according to their type, such as sequential, parallel, or loop, **without consulting an AI model** for assistance with the orchestration. This approach results in **deterministic and predictable** execution patterns.”  
> — https://adk.dev/agents/workflow-agents/

> “The execution of a **LoopAgent** object is **not controlled by an AI model**, and is **deterministic** in how it executes its sub-agents. The sub-agents within the defined loop may or may not utilize AI models…”  
> — https://adk.dev/agents/workflow-agents/loop-agents/

**Loop does not self-stop without developer mechanism:**

> “**Crucially**, the LoopAgent itself does *not* inherently decide when to stop looping. You *must* implement a termination mechanism… **Max Iterations**… **Escalation from sub-agent**… (e.g., ‘Is the document quality good enough?’).”  
> — https://adk.dev/agents/workflow-agents/loop-agents/

**Critic is an LLM agent (judge/revision content), not the orchestrator:**

> “**Critic Agent:** An LlmAgent that critiques the draft… The CriticAgent could be designed to return a ‘STOP’ signal when the document reaches a satisfactory quality level… Alternatively, the max iterations parameter…”  
> — https://adk.dev/agents/workflow-agents/loop-agents/

**Iterative refinement = Loop + LLM checker + hard escalate:**

> “**Termination:** The loop typically ends based on **max_iterations** or a dedicated checking agent setting **escalate=True** in the Event Actions when the result is satisfactory.”  
> — https://adk.dev/workflows/patterns/#iterative-refinement  

Conceptual chain: `code_refiner` → `quality_checker` (LLM outputs `'pass'|'fail'`) → `CheckStatusAndEscalate` (deterministic read of state → `EventActions(escalate=should_stop)`).

**Graph loop with critic routes:**

> “A loop repeats a set of steps until a termination condition is met… expressed as a **back-edge**… critic node emits a route (`'REFINE'` or `'DONE'`)…”  
> — https://adk.dev/graphs/routes/#loop-and-escalation-exit

**Offline eval mixes hard match and LLM judge:**

| Criterion | LLM-as-a-Judge |
| --- | --- |
| `tool_trajectory_avg_score` | No (exact/in-order/any-order match) |
| `response_match_score` | No (ROUGE-1) |
| `final_response_match_v2`, rubric-based metrics, safety, multi-turn quality | Yes |

— https://adk.dev/evaluate/criteria/

> “Due to the probabilistic nature of models, **deterministic ‘pass/fail’ assertions are often unsuitable**… Instead, we need qualitative evaluations…”  
> — https://adk.dev/evaluate/  
(Applies to the **evaluation product**, not claiming LoopAgent is non-deterministic.)

**Callbacks** (validation/skip, not Feedback Graph):  
`before_agent_callback` / `after_agent_callback` on any `BaseAgent` including workflow agents.  
— https://adk.dev/callbacks/types-of-callbacks/

---

## Relevance to Task/Agent/Feedback three-layer model

- **ADK has no named “Feedback Graph” layer** as a third co-equal product product; feedback/revision is a **pattern** on **`LoopAgent` or graph back-edges**, usually with an LLM **Critic** inside a **deterministic** controller.
- **Hard gates exist at the control plane** (`max_iterations`, escalate/route DONE), while **pass criteria are often agentic** (LLM quality_status / critique phrase) unless the developer implements pure code checks in a `BaseAgent`/function node.
- **Offline evaluation is orthogonal**: trajectory hard-match + optional LLM-as-judge for scoring agents in CI/tests — not the same as in-run critic loops.

---

## Sources (URLs)

- https://adk.dev/agents/workflow-agents/
- https://adk.dev/agents/workflow-agents/loop-agents/
- https://adk.dev/agents/workflow-agents/sequential-agents/
- https://adk.dev/agents/workflow-agents/parallel-agents/
- https://adk.dev/workflows/patterns/
- https://adk.dev/graphs/
- https://adk.dev/graphs/routes/
- https://adk.dev/agents/custom-agents/
- https://adk.dev/callbacks/types-of-callbacks/
- https://adk.dev/evaluate/
- https://adk.dev/evaluate/criteria/
- https://github.com/google/adk-python (issues/discussions re: LoopAgent escalate / max_iterations; secondary confirmation of exit semantics)
- Mirror docs: https://google.github.io/adk-docs/ (same content family as adk.dev)
