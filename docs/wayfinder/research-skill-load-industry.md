# Research: How mainstream agents load skills into context

**Date:** 2026-08-01  
**Scope:** Industry skill/methodology loading patterns for Wave 2 Spec (Node4 expert packs).  
**Question:** Do agents need explicit unload/replace under a hard max of 2, or is loading more natural (always-on index, progressive disclosure, host selection, auto-evict, no unload)?

**Sources:** Anthropic engineering post + agentskills.io specification; Cursor docs + dynamic-context blog (summaries); OpenAI/Codex skill docs (secondary + community mirrors of official progressive-disclosure language); local Grok user guide (`~/.grok/docs/user-guide/08-skills.md`); Node4 `skill` tool + pack `work.md` (code facts only).

---

## Executive answer

Mainstream coding/agent products converge on **progressive disclosure**: always-on **metadata index** (name + description ≈ 50–100 tokens per skill), then **body load on relevance** (model judgment, slash command, or file read), then optional **references/scripts on demand**. There is **no mainstream host-enforced “max 2 active deep skills + mandatory unload”** API. Context pressure is handled by keeping the index tiny, loading bodies only when needed, and ordinary chat/compaction—not by a skill-slot machine. Our **Node4** shape already matches the industry *contract* (`list` = metadata, `load` = body, no unload, no host max). Soft “prefer one / never bulk-load” in pack prompts is fine; a **hard max-2 + mandatory unload** is **atypical** (closer to Black-cat red-team working-set discipline than Claude/Codex/Cursor/Grok). For Wave 2, prefer **progressive disclosure + soft working-set guidance** over a host skill-eviction system unless lab evidence shows bulk-load is a real failure mode.

---

## Common pattern: index (metadata) vs body load

| Layer | What loads | When | Typical cost |
|-------|------------|------|--------------|
| **L1 Metadata** | `name` + `description` (YAML frontmatter) | Session start / always available | ~50–100 tokens per skill; all installed skills |
| **L2 Instructions** | Full `SKILL.md` body | When skill is relevant or user invokes `/name` | Prefer &lt;5k tokens / &lt;500 lines |
| **L3 Resources** | `references/`, `scripts/`, `assets/` | Only if L2 points there and agent needs them | Unbounded if progressive |

This three-level model is the **Agent Skills open standard** (agentskills.io) and is documented the same way by Anthropic, Cursor, Codex, and Grok (format-compatible).

**Not skills (related but different):** always-on project rules (`AGENTS.md`, `CLAUDE.md`, Cursor always-apply rules) sit in the permanent prompt—they are **not** progressive skill bodies.

---

## Product comparison

### 1. Claude Code / Anthropic Agent Skills

| Dimension | Behavior |
|-----------|----------|
| **Format** | Directory + `SKILL.md` with required `name` / `description` frontmatter; optional scripts/references/assets |
| **Index** | Host preloads **name + description of every installed skill** into the system prompt at startup |
| **Body load** | Model decides relevance from metadata; loads full `SKILL.md` (Anthropic engineering: often by **reading the file** via tools/bash). User may also invoke explicitly |
| **Who chooses** | **Model** (description match) or **user** (slash / explicit). Host does **not** keyword-route free text into a skill id as a hidden table |
| **Eviction / max** | **No documented max-active-skills cap.** No unload tool. Progressive disclosure is the scale story; long context uses normal session/compaction behavior |
| **Third level** | Linked files only when the agent navigates to them; scripts can run **without** loading source into context |

Primary reference: Anthropic engineering, *Equipping agents for the real world with Agent Skills* (progressive disclosure; metadata always; body on trigger; resources as needed). Spec mirror: [agentskills.io/specification](https://agentskills.io/specification).

### 2. Grok Build / Grok Code TUI skills

| Dimension | Behavior |
|-----------|----------|
| **Format** | Same `SKILL.md` convention; discovery from `.grok/skills/`, `.agents/skills/`, plus Claude/Cursor compat paths |
| **Index** | Skills advertised via slash menu / inspect; auto-invocation uses `description` and optional `when-to-use` |
| **Body load** | Slash `/skill-name` **loads instructions into the conversation**; automatic invocation when prompt matches description |
| **Who chooses** | User slash **or** model auto-invoke (unless `disable-model-invocation: true`) |
| **Eviction / max** | User guide documents **discovery, priority, disable/ignore**—**not** unload, LRU, or max-2 active. Matches observation that agents rarely “unload then reselect”: **there is no unload concept to exercise** |
| **Rules vs skills** | `AGENTS.md` / rules dirs are **auto-loaded** path-scoped always-on context; skills are task packages activated when applicable |

Primary reference: local `~/.grok/docs/user-guide/08-skills.md`, `12-project-rules.md`.

### 3. Cursor / Codex / ecosystem

**Cursor**

- Supports **Agent Skills** open standard; skills under `.cursor/skills/`, `.agents/skills/`, plus Claude/Codex compat roots.
- Docs: startup discovery → agent sees available skills → **agent decides** when relevant; manual `/name` also works.
- **Progressive:** load resources on demand; name/description used for relevance; optional `paths` globs **host-scopes which skills are surfaced** by open files (OS-level *selection*, not unload).
- **Rules** remain a parallel system: always-apply vs intelligent vs path-scoped—closer to permanent prompt policy than skill bodies.
- Blog *Dynamic context discovery*: skills’ short metadata as static context; full content via dynamic discovery (tools/search)—still progressive, not slot-eviction.
- Forum reports of **duplicate multi-path skill loading** (context waste) point to weak de-dupe, **not** a mature max-N + unload manager.

**OpenAI Codex / ChatGPT skills** (official progressive-disclosure language via product docs mirrors)

- Startup: name + description (Codex list may include file path).
- Full `SKILL.md` when the agent decides to use the skill.
- **Index budget:** skill list capped roughly at **≤2% of context window** (or ~8k chars if window unknown); if too many skills, **descriptions are shortened or some skills omitted from the initial list**—this is an **index** budget, **not** a max-2 active-body rule.
- Secondary writeups sometimes say “context is released after the job”; treat as **session/turn hygiene narrative**, not a verified host `unload` API with mandatory agent calls.

**Ecosystem takeaway:** Claude / Codex / Cursor / Gemini CLI / Grok all adopt the same **metadata → body → resources** ladder. Differences are discovery roots and invocation UX, not “skill slots with eviction.”

### 4. Our product today (Node4 — facts only)

| Fact | Source |
|------|--------|
| Tool ops: **`list` \| `load` only** | `node4/src/tools/skill.ts` |
| `list` returns **id / name / description** (no bodies) | same |
| `load` returns **one** skill body; guidance text: *do not load everything* | same |
| **No `unload` op**; **no host-enforced max active** | same |
| Pack soft policy: **at most one** methodology skill at start; rotate by loading **one** other when stuck; never bulk-load | `experts/pentest/work.md`, `mission.md` |
| Harness language already prefers progressive skill/refs load over encyclopedia system prompts | `docs/specs/harness.md` |
| Black-cat-inspired **default 1 / max 2 active deep** appears in **wayfinder research** as a candidate discipline (L6), not as implemented host law | `docs/wayfinder/research-black-cat-*.md` |

So: we already implement the **industry tool shape** (index vs body). The “max 2 + unload” idea is an **aspirational hardening** from red-team framework research, **not** something coding agents standardize on.

---

## Cross-cut answers

### Who chooses which skill?

| Mechanism | Mainstream | Our Node4 |
|-----------|------------|-----------|
| Always-on metadata index | Host injects L1 | Agent must `skill(list)` (or pack may teach list once)—**not** automatic L1 inject today |
| Relevance selection | **Model** from description (or user slash) | **Model** `skill(load, id=…)` by judgment |
| Host keyword routing of free text | **Avoided** (AGENTS.md-compatible stance industry-wide) | **Forbidden** for engagement/workflow invent |
| Path / seat scoping | Cursor `paths`; pack skillIds | Pack `skillIds` filters **list** catalog |

### Eviction / context management

| Approach | Used by mainstream? | Notes |
|----------|---------------------|-------|
| Explicit agent `unload` | **No** (not documented as product primitive) | Conversation history still retains prior loads |
| Host hard max 2 active | **No** for coding agents | Black-cat-style **technique working set** is domain-specific |
| LRU auto-evict of skill bodies | **Not** a published skill API | Compaction/summarization is session-level |
| Index truncation when many skills | **Yes** (Codex ~2% window) | Drop/shorten **catalog**, not “active” bodies |
| Soft prompt: prefer one / don’t bulk-load | **Yes** (best practice) | Our `work.md` already does this |
| One-shot inject then forget | Partial narrative only | Reality: tokens stay in history until compact |

**Implication:** Requiring the agent to **unload then reselect** is **high friction and atypical**. Models trained/used in Claude/Codex/Cursor/Grok environments are not taught a skill-slot FSM; they load when needed and rely on context rot/compaction.

---

## Does “max 2 active deep skills + mandatory unload” match mainstream?

| Claim | Verdict |
|-------|---------|
| Always-on metadata + progressive body | **Mainstream** |
| Soft prefer-one methodology skill | **Common best practice** (and our packs) |
| Hard max 2 active bodies enforced by host | **Atypical** for coding agents |
| Mandatory unload before next skill | **Atypical**; no peer product API |
| Thick library + thin load | **Mainstream design goal** (Agent Skills) |
| Black-cat “active technique files default 1 max 2” | **Domain-specific working-set** discipline—useful *idea*, not industry skill-loader standard |

**Conclusion:** Treat hard max-2 + unload as a **product-specific harness experiment**, not as “matching Claude/Grok/Cursor.” Soft working-set language **does** match mainstream. Host enforcement should require evidence (bulk-load regressions), not cargo-cult.

---

## Recommendation for Wave 2 Spec (ranked options)

### Option A — Align with progressive disclosure (recommended default)

**Design**

- Keep `skill(list|load)` as today (or add **host-injected L1 catalog** of pack skillIds into system/work prompt so the model need not list every turn).
- Soft pack policy: **prefer one deep skill**; rotate by loading another when the class is exhausted; **never bulk-load**.
- No `unload`; no host max.
- Optional: warn in tool result if `load` count in the last N turns is high (telemetry), still non-blocking.

**Tradeoffs**

| + | − |
|---|---|
| Matches Claude/Codex/Cursor/Grok | Model can still over-load |
| Zero new tool ops / FSM | Soft guidance may be ignored |
| Lowest agent friction | Relies on prompt + skill quality |
| Consistent with AGENTS harness-over-restriction | Less “enforced” than Black-cat L6 wording |

### Option B — Soft working-set with host *soft* limit (recommended if lab shows bulk-load)

**Design**

- Same progressive disclosure as A.
- Host tracks skills loaded this Graph stage / main turn window.
- Soft cap e.g. **prefer ≤2 bodies** in a stage: on 3rd+ `load`, return body **plus** a non-blocking reminder (“multiple skills already loaded this stage; prefer rotate after deadend”).
- Optional later: **hard reject 3rd load** only behind a lab flag—not product default.

**Tradeoffs**

| + | − |
|---|---|
| Implements Black-cat *intent* without unload theater | Extra host state |
| Preserves model choice for 1–2 concurrent classes | Soft reminder may be ignored |
| Telemetry-friendly | Defining “stage window” must be careful |

### Option C — Hard max 2 + mandatory unload (not recommended as default)

**Design**

- Host maintains active set size ≤2.
- `load` of a third skill fails unless `unload` (or replace) first.
- Explicit `skill(op=unload, id=…)` removes from “active” host view (note: **history tokens remain** unless compaction is also designed).

**Tradeoffs**

| + | − |
|---|---|
| Strict sparse working set | **Atypical** vs mainstream agents |
| Clear for audits | Agents will waste turns on unload/reselect |
| Matches Black-cat max-2 literally | “Unload” does not free past context without compaction |
| | Risks fighting the model; may need hardcoded recovery paths (AGENTS: avoid) |

**Rank:** **A > B > C** for product default. Use **B** if smoke/lab shows systematic multi-skill dump. Use **C** only with explicit product approval and lab proof that soft guidance fails.

---

## Spec implications (Wave 2 — draft language, not implemented)

1. **Contract:** Skills = progressive disclosure packages; **index metadata ≠ body**.
2. **Selection:** Model or explicit UI/pack field—not free-text keyword routing in platform/Node code.
3. **Default policy:** Prefer one deep methodology skill; rotate on deadend; never bulk-load—all **prompt/pack**, not host ACL.
4. **Do not** introduce mandatory unload as default without evidence.
5. **Optional enhancement:** host-injected pack skill catalog (L1) so list is free; keep `load` for L2.
6. **Separate** always-on mission/work/RoE from progressive skills (rules vs skills).
7. **Black-cat L6** maps to Option A/B “working set discipline,” not Option C unless reopened with data.

---

## Quick reference matrix

| Product | Index always-on | Who loads body | Unload API | Hard max active |
|---------|-----------------|----------------|------------|-----------------|
| Claude Code / Anthropic Skills | Yes (name+desc) | Model / user | No | No |
| Grok skills | Catalog + slash; auto via description | Model / user slash | No | No |
| Cursor Skills | Discovered metadata; path scoping | Model / user `/` | No | No |
| Codex Skills | Yes; index size budgeted | Model / `$skill` | No | No (index budget only) |
| Node4 today | Via `list` tool (not auto-injected) | Model `load` | No | No (soft “at most one” in work.md) |

---

## Source index

| Source | Role |
|--------|------|
| Anthropic, *Equipping agents… with Agent Skills* (2025-10) | Progressive disclosure; system prompt metadata; body/resources on demand |
| [agentskills.io/specification](https://agentskills.io/specification) | Open standard L1/L2/L3 |
| Cursor docs Agent Skills; *Dynamic context discovery* blog | Discovery, progressive load, path scoping |
| OpenAI/Codex skill progressive disclosure docs (product + community mirrors) | Index ≤~2% context; body on use |
| `~/.grok/docs/user-guide/08-skills.md` | Grok discovery, auto-invoke, slash inject; no unload |
| `node4/src/tools/skill.ts`, `experts/pentest/work.md` | Our list/load contract + soft one-skill policy |
| `docs/wayfinder/research-black-cat-*.md` | Origin of max-2 active deep *as research*, not industry standard |

---

*Living research note for Spec authors. Not product authority; does not change harness.md until a Spec lands.*
