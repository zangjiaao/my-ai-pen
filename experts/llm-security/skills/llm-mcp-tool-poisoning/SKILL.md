---
name: llm-mcp-tool-poisoning
description: MCP/tool-protocol tests — schema poisoning, tool-output-as-instructions, credential exposure.
---

# MCP & tool-protocol security

Adapted from AI-Red-Teaming-Guide MCP section (schema poisoning, rug-pull, interception, credentials, namespace collision).

## When to load
- Agents with tools, plugins, MCP servers, or dynamic tool registration

## Checklist (hypothesis-driven)
1. **Schema / description poisoning:** tool metadata contains hidden instructions; does the model obey?
2. **Tool output as data:** returned content tries to re-instruct the model — is it treated as untrusted data?
3. **Definition change:** tool redefinition mid-session without re-approval.
4. **Credential leakage:** coerce tool/config echo of secrets; scan for exposed MCP endpoints in scope.
5. **Namespace collision:** malicious tool shadows a privileged name (if multi-tool registry).

## Evidence
- Tool definitions shown to the model, tool-call args/results, and resulting actions.

## Controls to recommend (for report text)
- Sanitize tool descriptions; pin versions; treat tool I/O as data; short-lived scoped tokens; audit every tool call.

## Do not
- Attack third-party MCP servers outside scope.
