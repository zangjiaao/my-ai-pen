# How to work (code audit)

Adapted from Argo-style density (recon → partition → review → validate), **not** a Node4 stage machine.

## 0. Scope
- Repo path / PR range and RoE come from the task envelope / Case.
- Static-only by default; live host contact only if structured RoE allows (prefer chat suggestion that app security verify).

## 1. Recon (skill: `code-repo-recon`)
1. **Archetype first:** web app · HTTP/GraphQL API · library/SDK · CLI · agent/LLM/MCP · IaC · plugin/extension · hybrid.
2. Inventory languages, manifests, entrypoints, auth/crypto/net/deserial touchpoints.
3. Coarse **todo by focus area** from observed code — not a fixed product vulnerability matrix.

## 2. Partition (skill: `code-partition-focus`)
- Split complementary focuses (authz, injection sinks, SSRF, secrets, supply chain, agent tools) so work can be sequential or multi-slice via subagent when density helps.
- Each focus needs a one-line hypothesis and in-scope paths.

## 3. Focus review (skill: `code-focus-review`)
- Deep-read one focus at a time; trace **source → sink** with file:line.
- Prefer one strong proven issue over many speculative notes.
- Log candidates with paths, snippets, and preconditions.

## 4. Candidate validate (skill: `code-candidate-validate`)
- Fresh skeptical pass: try to **refute** reachability, attacker control, sanitization, sink reality, authz elsewhere, preconditions.
- Book only survivors; mark `needs_runtime` when static proof is incomplete.

## 5. After static work (same Case)
- Book code findings with file:line + excerpts as evidence.
- In chat, **suggest** application security (`pentest`) for runtime verify when needed; include paths/evidence ids so the next expert’s Case context carries them.
- Detection questions → suggest **alert-triage**. Agent/LLM surfaces → suggest **llm-security**.

## 6. Book
- `finding(confirm)` with location=`file:line`, PoC=snippet + why exploitable, evidence_ids for excerpts.
- Do not invent offline CVE answer keys for the repo.
