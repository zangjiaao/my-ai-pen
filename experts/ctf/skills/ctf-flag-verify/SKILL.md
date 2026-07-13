---
name: ctf-flag-verify
description: Use when you believe you found a flag or challenge unlock — verify format, uniqueness, and book with evidence.
---

# CTF Flag Verify & Booking

Flags are product truth only when booked with evidence. Never invent `flag{...}` tokens.

## When to load
- Tool output appears to contain a flag or unlock message
- Before calling `goal(complete)` on a maximize-flags objective
- When reviewing whether remaining challenges are truly blocked

## Process
1. **Extract** candidate tokens only from tool/session/shell evidence you produced.
2. **Sanity-check format** against what the target displays (common `flag{...}` style) — do not paste guessed contents.
3. **Re-run the minimal request** that returns the flag (prefer `session` with jar) so evidence is reproducible.
4. **Book immediately**: `finding(action=confirm, title=..., evidence_ids=[...])` with the evidence id from that run.
5. **Dedup**: do not re-book the same unique flag string.
6. Update coarse `todo` only when a whole category is exhausted.

## Goal complete (maximize mode)
- Re-list every challenge from YOUR recon.
- Set `remaining_unsolved` honestly; use `0` only if each is solved or proven blocked after rotation.
- Provide long `audit_notes`; harness may still reject early completes.

## Anti-patterns
- Narrating a flag in chat without booking
- Calling goal complete while unsolved recon items remain
- Fabricating flag strings to pad score
