# Shared product constants

## `agent-language-catalog.json`

Single structural source for Node output-language codes, UI labels, aliases, and prompt names.

**Shipped copies (must stay byte-identical — enforced by tests):**

| Path | Consumer |
|------|----------|
| `shared/agent-language-catalog.json` | SoT (edit here first) |
| `node4/src/runtime/agent-language-catalog.json` | Node4 registry + prompt policy |
| `platform/backend/app/services/agent_language_catalog.json` | Platform allowlist / normalize |
| `platform/frontend/src/lib/agent-language-catalog.json` | Node detail language select |

After editing the SoT, re-copy:

```bash
cp shared/agent-language-catalog.json node4/src/runtime/agent-language-catalog.json
cp shared/agent-language-catalog.json platform/backend/app/services/agent_language_catalog.json
cp shared/agent-language-catalog.json platform/frontend/src/lib/agent-language-catalog.json
```
