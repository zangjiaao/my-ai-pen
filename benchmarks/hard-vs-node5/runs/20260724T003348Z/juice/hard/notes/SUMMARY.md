# Hard arm — mature Hard Graph (post-#69)

**Graph:** `hard_app_assessment` → `graphs/hard/app_assessment.json`
**Target:** http://127.0.0.1:3010 (`juice-hvn5-hard`)
**Stamp:** `20260724T003348Z`
**Model:** deepseek/deepseek-v4-flash
**SHA:** `3e66b7b9952c`
**Terminal:** completed (hard_graph_completed)
**Booked findings:** 18
**Wall-clock:** ~2200s

## Stages

init → surface → auth_session → class_probe (fan-out) → authz_logic → component → validate_book

## Booked findings

1. high — Null Byte Injection - File Extension Filter Bypass (`GET http://127.0.0.1:3010/ftp/{file}%2500.md`)
2. critical — SQL Injection in Login - Authentication Bypass (`POST http://127.0.0.1:3010/rest/user/login`)
3. critical — Mass Assignment - Admin Registration via API (`POST http://127.0.0.1:3010/api/Users`)
4. high — Excessive Data Exposure - Users API Returns Password Hashes (`GET http://127.0.0.1:3010/api/Users`)
5. high — SQL Injection in Product Search (`GET http://127.0.0.1:3010/rest/products/search?q=`)
6. high — SQL Injection in Product Search Endpoint (`GET http://127.0.0.1:3010/rest/products/search?q=`)
7. critical — Mass Assignment - Admin Registration via Users API (`POST http://127.0.0.1:3010/api/Users`)
8. high — Excessive Data Exposure - Users API Returns Password Hashes (`GET http://127.0.0.1:3010/api/Users`)
9. high — Null Byte Injection - File Extension Filter Bypass (`GET http://127.0.0.1:3010/ftp/suspicious_errors.yml%2500.md`)
10. medium — Directory Listing Enabled on /ftp/ (`GET http://127.0.0.1:3010/ftp/`)
11. medium — Weak Captcha - Answer Exposed in API Response (`GET http://127.0.0.1:3010/rest/captcha`)
12. medium — Security Question Exposed for Any User Email (`GET http://127.0.0.1:3010/rest/user/security-question?email=`)
13. high — Password Reset via Known Security Answer - Bjoern's Account (`POST http://127.0.0.1:3010/rest/user/reset-password`)
14. high — Password Change via GET Request (CSRF/Sessionless) (`GET http://127.0.0.1:3010/rest/user/change-password?current=`)
15. high — JWT Token Exposes Password Hash and Internal Data (`JWT token from POST http://127.0.0.1:3010/rest/user/login`)
16. medium — No Logout Endpoint - Token Cannot Be Invalidated (`POST http://127.0.0.1:3010/rest/user/logout`)
17. low — Challenge Data Exposure via API (`GET http://127.0.0.1:3010/api/Challenges`)
18. medium — JWT Token Has No Expiration Claim (`JWT token from POST http://127.0.0.1:3010/rest/user/login`)
