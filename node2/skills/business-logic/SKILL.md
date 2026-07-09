---
name: business-logic
description: Use when workflows involve multi-step processes, carts, orders, payments, coupons, ratings, quantity/price fields, role transitions, or any state machine the server should enforce beyond input validation.
---

# Business Logic And Workflow Abuse

Scanner-style injection is not enough. Abuse **what the server allows in process**.

## When to apply

After recon shows state-changing or multi-step surfaces: cart/basket, checkout, coupon, feedback/rating, password change, role upgrade, transfer, multi-step wizards, CAPTCHA-gated submits, quantity/price fields.

## Methodology

1. Map the legitimate happy path with real traffic (`browser`/`http`/`traffic`) under a known actor.
2. Identify server-enforced assumptions: ownership, step order, quantities, prices, one-time tokens, CAPTCHA, role.
3. Attack each assumption deliberately:
   - **Skip / reorder steps** (jump to finish, replay completed step).
   - **Tamper values** (quantity 0/-1, price 0, rating out of range, role elevation fields).
   - **Cross-actor workflow** (apply actor B's coupon to actor A's cart; act on B's object as A).
   - **Replay / duplicate** sensitive actions (double spend, double redeem).
   - **Client-only gates** (remove CAPTCHA/token fields; use `verifier` javascript-logic or business-logic).
4. Prefer `verifier(vuln_class='business-logic', fields={...}, privileged_fields={...})` for field tampering, and dual-actor `http(actor=...)` pairs for ownership/workflow breaks.
5. Confirm only with proof the illegal state was accepted (response body, subsequent resource state, or privileged capability gained).

## Evidence

- Baseline happy-path request/response.
- Tampered or cross-actor request/response.
- Follow-up read proving durable bad state when applicable.
- Coverage class `business-logic` with notes describing the broken rule.

Do not invent application-specific challenge answers. Derive candidates only from observed endpoints, parameters, and workflows.
