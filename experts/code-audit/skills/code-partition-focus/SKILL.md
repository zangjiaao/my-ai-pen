---
name: code-partition-focus
description: Split complementary audit focuses for sequential or multi-slice review.
---

# Partition focus

Adapted from Argo multi-prompt / focus partitioning (complementary slices, not kill-chain stages).

## When to load
- Repo is large or multi-surface after recon
- Considering subagent multi-slice for density

## Process
1. From recon profile, list **complementary** focuses (e.g. authz · injection · SSRF/egress · secrets · supply-chain · agent-tools).
2. Each focus: hypothesis one-liner + path globs / modules + out-of-scope notes.
3. Prefer 3–8 focuses; mark priority by blast radius / attacker reachability.
4. Work sequentially **or** dispatch subagent per focus only when density helps — not forced for tiny repos.
5. After slices return, de-duplicate candidates before validate/book.

## Do not
- Name focuses after kill-chain stages (recon/exploit/postex) — those are other packs.
- Invent a mandatory matrix of categories the code does not have.
