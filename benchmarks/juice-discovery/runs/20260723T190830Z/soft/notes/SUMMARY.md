# Soft arm summary — product soft control (core-only)

**Path:** product soft scenario graph `app_assessment` + `graph-main-act soft` (`work_mode=graph:app_assessment:delegate_preferred`)  
**Not** Hard Graph. **Not** omp-juice historical re-badge.  
**Runtime:** core-only `runNode4Agent` (pi-ai + pi-agent-core; no pi-coding-agent)  
**Target:** http://127.0.0.1:3011 (clean `juice-discovery-soft`)  
**Terminal:** `completed`  
**Findings:** **6** evidence-backed bookings  
**Wall-clock:** ~410s  

## Findings (titles only)

1. Mass Assignment - Privilege Escalation via User Registration (high) — POST /api/Users  
2. SQL Injection in Product Search API (critical) — /rest/products/search  
3. Weak/Default Credentials - Admin Password Easily Crackable (high) — /rest/user/login  
4. Sensitive Data Exposure - Admin Application Configuration (medium) — /rest/admin/application-configuration  
5. IDOR - Unauthorized Access to Another User's Basket (high) — GET /rest/basket/1  
6. Stored XSS via Product Reviews API (high) — PUT /rest/products/1/reviews  

## Fairness vs Hard (same dual-arm stamp)

| | Hard | Soft |
|--|------|------|
| Graph | `app_assessment_thin` Hard Graph | `app_assessment` soft |
| Terminal | blocked @ init | completed |
| Findings | 0 | 6 |
| Why | result.json handoff fail-closed; no recon stage | Full soft recon + booking tools |

Soft **must not** be claimed as Hard Graph product capability. Hard gap tracked in [Hard Graph: init stage result.json handoff fails closed](https://github.com/zangjiaao/my-ai-pen/issues/57).
