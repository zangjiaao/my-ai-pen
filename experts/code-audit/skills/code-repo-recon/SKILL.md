---
name: code-repo-recon
description: Map repository archetype, entrypoints, and trust boundaries before deep review.
---

# Repo recon

Adapted from Argo recon synthesis (profile first, audit later).

## When to load
- Start of a code-audit engagement
- Large monorepo or unknown stack

## Process
1. **Classify archetype** (or hybrid): web · API · CMS · plugin/extension · library · CLI · **agent/LLM/MCP** · mobile · data/ML · IaC · firmware. State it explicitly — it drives focus choice.
2. Inventory languages, package manifests, build/CI, containers, notable scripts — exact paths.
3. Reconstruct **execution model for this archetype** (HTTP routes, CLI entry, agent tools, host callbacks — not always “web routes”).
4. Note trust boundaries: auth, crypto, network egress, deserialization, secret material, multi-tenant.
5. Build coarse **todo by focus area** from what you observed.

## Outputs
- Short repo profile notes in workspace
- Focus list (3–8) for partition/review

## Do not
- Invent architecture not supported by the tree.
- Contact live hosts in this skill (static only).
