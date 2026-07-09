---
name: access-control
description: Use when object IDs, user IDs, tenant IDs, roles, admin functions, direct file/API access, or authenticated endpoints may lack server-side authorization checks.
---

# Access Control, IDOR, And Multi-Privilege Testing

Authorization bugs require **two identities**, not one token and neighbor IDs.

## Required identity setup

1. Create or log in as **Actor A** (owner). Immediately `actor(action='capture', id='user_a', ...)`.
2. Create or log in as **Actor B** (peer or lower privilege). `actor(action='capture', id='user_b', ...)`.
3. Optionally capture a higher-privilege actor when obtainable (`admin`) without destroying A/B.
4. Confirm with `actor(action='list')` that at least two actors have auth material.

Never overwrite actor A when logging in as B.

## Horizontal access (same role, different owner)

1. As actor A, create or list an owned object and note `object_id`.
2. Baseline: `http` or `verifier` as actor A on that object — should succeed.
3. Attack: `verifier(vuln_class='idor', actor='user_a', alt_actor='user_b', object_id=<A_owned_id>, url=...)`.
4. Confirm only when B receives A's data/actions without authorization.
5. Mark coverage notes including `dual-actor`.

## Vertical access (privilege boundary)

1. Capture low-privilege and high-privilege actors when both exist.
2. Replay admin-only endpoints/actions as the low-privilege actor.
3. Prove status/body differences and impact (read or state change).

## Unauthenticated control

Also replay sensitive endpoints with no actor / stripped auth as a third context when useful.

## Evidence rules

- Record which actor performed each request.
- Confirm only with request/response differentials tied to identity.
- One basket IDOR does **not** exhaust access-control — retest other object classes (orders, feedback, profiles, files) with dual actors.
- Use test accounts only; avoid third-party personal data.

Look up `poc(action='get', vuln_class='access-control')` for additional methodology after identities exist.
