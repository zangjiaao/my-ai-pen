# Node5 arm — lab CLI app_assessment (post-#69 dual-arm)

**Graph:** `app_assessment` (Node5 ADK)
**Target:** http://127.0.0.1:3011 (`juice-hvn5-node5`)
**Stamp:** `20260724T003348Z`
**Model:** deepseek/deepseek-v4-flash
**Terminal:** completed (exit 0)
**Booked findings:** 15
**Wall-clock:** ~2846s

## Stages

init → surface → prior_reverify → auth_session → class_probe → authz_logic → component → validate_book → finalize

## Booked findings

1. critical — Mass Assignment Privilege Escalation via POST /api/Users (`/api/users`)
2. critical — SQL Injection in /rest/products/search — Full Database Extraction (`/rest/products/search`)
3. high — Missing Authentication on Product API (BFLA) (`/api/products/{id}`)
4. critical — JWT Algorithm Confusion Attack - Forged Admin Token via alg:none and HS256 with RSA Public Key (`/rest/user/whoami`)
5. medium — Security Question Enumeration via /rest/user/security-question (`/rest/user/security-question`)
6. critical — Unauthenticated Mass User Data Disclosure via /api/Users (`/api/users`)
7. critical — Unauthenticated basket access and order placement (IDOR + authz bypass) (`/rest/basket/{id}`)
8. medium — Unauthenticated order history disclosure via /rest/order-history (`/rest/order-history`)
9. critical — Unauthenticated admin account takeover via empty-current-password in /rest/user/change-password (`/rest/user/change-password`)
10. high — Directory Listing - Sensitive Key Disclosure (`/encryptionkeys`)
11. high — SSRF via Profile Image URL (Server-Side Request Forgery) (`/profile/image/url`)
12. high — 2FA Bypass via Self-Service TOTP Secret Exposure (`/rest/2fa/setup`)
13. medium — TOTP Secret Disclosure via Unauthenticated /rest/2fa/status (`/rest/2fa/status`)
14. medium — Password Hash Leakage via /rest/memories (`/rest/memories`)
15. high — Broken access control — cross-actor or unauthenticated object access (`/api/users`)
