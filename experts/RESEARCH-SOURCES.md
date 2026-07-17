# Research sources for expert-pack methodology

Expert packs under `experts/` may **adapt** ideas from `research/` into mission/work/skills.
They do **not** vendor or import those codebases at runtime.

| Pack | Primary research inputs (adapted) |
|------|-----------------------------------|
| `llm-security` | `research/AI-Red-Teaming-Guide` (methodology, attack vectors, MCP/tool, RAG, agentic ASI themes); `research/deepteam` (vuln×attack×judge shape, multi-turn jailbreak family names) |
| `code-audit` | `research/argo` (adversarial validation of candidates, focus partitioning, proof excerpts) |
| `alert-triage` | `research/AI-Red-Teaming-Guide` (purple team, detection gaps, harm severity bands) |
| `pentest` | Platform scenarios + classic process as **skills** (not stage Experts); chat suggestions for other packs. **Adapted (v1.1.0):** `research/ClaudeBrain` hunt methodology (test order, deadend/OOB, dual-path component), thin `refs/payloads` + `refs/components` — see [`docs/expert-pack-capability-and-maintenance.md`](../docs/expert-pack-capability-and-maintenance.md) and `experts/pentest/CHANGELOG.md`. Do **not** vendor wiki, keyword triggers, or coverage-class gates; not a runtime dependency. |

**Rules when adapting:**

- Rewrite into short skill methodology; no fixed CVE/target answer keys.
- Prefer hypothesis-driven tests and evidence booking.
- Framework labels (OWASP ASI, NIST MAP/MEASURE) are **tags for reporting**, not mandatory coverage gates.
- Pack judgment (L1) vs sandbox tools/templates (L2) vs hand PoC (L3): update the layer that actually changed; see maintenance plan above.
