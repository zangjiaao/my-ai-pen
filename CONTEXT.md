# my-ai-pen

Ubiquitous language for the AI security workbench: one platform, one bound Node, expert packs, and Graph × Runtime shape.

## Language

### Product seats

**Default**:
The Node seat with no expert pack installed: tools for ledger management, status understanding, and report assistance. Never enters Expert Hard Graph.
_Avoid_: Free (as a second product concept), free mode, OMP-only product mode

**Expert**:
A specialized pack (e.g. pentest, CTF, code audit) installed on the same Node base. Execution work uses Hard Graph × Pi when graphDiscipline is hard.
_Avoid_: role seat, plugin (when meaning a full specialist pack)

**Node candidate**:
An implementation that can be bound as the product Node. **Product path (locked):** Node4 lineage with Graph × Pi only. Former Node5 lab tree is deleted; fallback B retired (ADR 0001 B1).
_Avoid_: dual product kernel, resurrecting node5 as bind target

### Runtime shape

**Expert Graph** (implementation synonym: **Hard Graph**):
Normative Task-stage control of **Expert** work (esp. pentest): ordered stages, fail-closed Feedback gates, stage tool profiles, Agent Graph fan-out on probe stages. Runner owns scheduling — not Main-as-scheduler. Product Expert DoD = Graph × Pi (mature graph primary; thin = lab alias only). Experts may offer **multiple Graphs**.
_Avoid_: soft scenario menu as product mode; prompt-only workflow; force_order as hints only; treating thin stub as full Expert DoD

**Soft scenario graph**:
**Retired product work mode.** Historical name for node menu + soft default_plan (Main may act). Not Expert DoD; not a third product path. Do not reintroduce on product UI or resolve.
_Avoid_: calling Soft "Expert Graph"; shipping Soft as optional Expert light path

**Agent Runtime**:
The loop that runs an agent with tools inside a graph stage or Default seat. Product packages: **pi-ai** (models) + **pi-agent-core** (loop). Product API: **Agent** + **AgentTool** + events/hooks via seam **runNode4Agent**. Not coding-agent shell, not AgentHarness, not pi-tui.
_Avoid_: calling the Graph framework itself "the Agent Runtime" when Graph and Runtime are layered; treating pi-coding-agent as required Runtime

**Graph × Pi**:
The **locked** product shape: Hard Graph orchestrates flow and gates; pi Agent Runtime runs exploration inside expert graph stages. Default seat stays outside expert hard Graph.
_Avoid_: hybrid (unqualified), soft OMP graph, Main-as-scheduler as hard Graph

**Graph model vs Graph framework**:
The model (Task / Agent / Feedback semantics) is required; a framework (e.g. Google ADK) is a replaceable implementation.
_Avoid_: "must use ADK" as a product requirement without a model reason

**Product state (SOT)**:
Node4-owned domain truth: multi-actor session jars, Hard Graph handoff/continuity (parent lifecycle, surface ledger, structured stage results), findings/booking inputs, Feedback/settlement inputs.
_Avoid_: treating LLM transcript or Agent Runtime session files as domain authority

**Runtime transcript**:
Turn-local agent messages inside the Agent Runtime. Optional Node4 projection from Runtime events for debug/stream; not required as a product session format; never used as fail-closed gate input.
_Avoid_: dual cookie stores; Feedback parsing private Runtime/session formats; salvage handoff from transcript
