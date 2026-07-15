---
name: alert-purple-replay
description: Re-run or re-check a red PoC after detection/mitigation to validate effectiveness.
---

# Purple-team replay

Adapted from AI-Red-Teaming-Guide purple cadence step: replay validates detection + containment.

## When to load
- Detection rule or mitigation claimed fixed
- Post-engagement purple exercise with authorized replay window

## Process
1. Load the original red finding PoC steps and evidence ids.
2. Confirm RoE allows replay (lab/staging preferred; production only if structured yes).
3. Re-execute **minimal** reproduction (or review recorded replay artifacts if red re-ran).
4. Check: detection fired? containment (kill-switch, session kill, tool disable) worked?
5. Record pass/fail per control; residual risk if only partial.

## Outputs
- Replay result linked to finding id + detection rule ids
- Backlog items for failed controls

## Do not
- Expand into full new red campaign inside this skill.
- Claim “fixed” without evidence of detection or containment.
