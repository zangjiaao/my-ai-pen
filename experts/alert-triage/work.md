# How to work (alert triage / purple)

Adapted from AI-Red-Teaming-Guide **Purple Team Operations** and harm-severity triage — not a stage machine.

## Purple operating cadence (when Case has red findings)
1. Red team identifies exploit chain + reproduction (already in Case / handoff).
2. You map **expected telemetry** and check detections (skills below).
3. Note IR/runbook gaps for critical paths (containment ideas only — you are not the product owner).
4. After product ships detection/mitigation, **replay** the PoC to validate detection + containment.
5. Retro notes: what failed, what improved, next detection backlog item.

## Day-to-day alert queue
1. **Enrich** (`alert-enrichment`) — normalize fields, assets, timeline.
2. **Verdict** (`alert-true-false-positive`) — TP / FP / inconclusive with evidence.
3. **Severity** (`alert-harm-severity`) — when impact ranking is needed (esp. AI/agent actions).
4. **Detection gap** (`alert-detection-gap`) — proven red PoC, no alert → document expected signals.
5. **Purple replay** (`alert-purple-replay`) — after fix/rule change, re-check same PoC.

## Book
- Outcomes need alert payloads, log excerpts, or explicit “no matching alert in window X”.
- Prefer linking red-team `finding` ids when available.
- Re-validation of exploit paths → structured handoff to application security or llm-security — not silent switch.

## Do not
- Invent alerts that did not fire.
- Treat keyword-only blocks as sufficient detections without evidence.
- Expand scope into offensive post-ex unless RoE is structured and authorized.
