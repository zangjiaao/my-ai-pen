# CTF recipes (non-answer templates)

Small scripts the agent may copy into the task `scripts/` dir or run via shell.
**No challenge solutions or flag values.**

| Recipe | Use |
|--------|-----|
| `session_chain_example.md` | How to replace curl -b/-c loops with `session` tool |
| `parse_flag_from_body.py` | Extract `flag{...}` patterns from a response file for booking prep |

Prefer the `session` tool for HTTP state. Use shell for scanners and one-off logic.
