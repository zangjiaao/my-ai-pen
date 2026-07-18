# OMP DVWA Penetration Test Summary

**Target:** http://127.0.0.1:8080  
**Date:** 2026-07-19  
**Security Level:** low  
**Authenticated:** admin:password (DVWA defaults)

## Finding Files (14 findings)

| # | File | Title | Severity |
|---|---|---|---|
| 1 | `findings/sqli.json` | SQL Injection - UNION-based data extraction | Critical |
| 2 | `findings/sqli_blind.json` | SQL Injection (Blind) - Boolean-based | Critical |
| 3 | `findings/command_injection.json` | Command Injection - RCE via ping | Critical |
| 4 | `findings/file_injection.json` | Local/Remote File Inclusion (LFI/RFI) | Critical |
| 5 | `findings/file_upload.json` | Unrestricted File Upload - RCE | Critical |
| 6 | `findings/xss_reflected.json` | XSS - Reflected | High |
| 7 | `findings/xss_stored.json` | XSS - Stored (Persistent) | High |
| 8 | `findings/xss_dom.json` | XSS - DOM-based | High |
| 9 | `findings/csrf.json` | CSRF - Password Change | High |
| 10 | `findings/insecure_captcha.json` | Insecure CAPTCHA - Bypass | High |
| 11 | `findings/brute_force.json` | Brute Force - No Rate Limiting | High |
| 12 | `findings/weak_session_ids.json` | Weak Session IDs - Non-Rotating | Medium |
| 13 | `findings/csp_bypass.json` | CSP Bypass | Medium |
| 14 | `findings/phpinfo_disclosure.json` | Information Disclosure - phpinfo() | Medium |

## Modules Tested

| Module | Tested | Vulnerable | Notes |
|---|---|---|---|
| SQL Injection | Yes | Yes | UNION injection, full DB dump |
| SQL Injection (Blind) | Yes | Yes | Boolean-based blind confirmed |
| Command Injection | Yes | Yes | RCE via `;`, `|`, backticks |
| File Inclusion | Yes | Yes | LFI via path traversal & PHP wrappers |
| File Upload | Yes | Yes | PHP shell uploaded, RCE confirmed |
| XSS (Reflected) | Yes | Yes | Script tag reflected verbatim |
| XSS (Stored) | Yes | Yes | Script persisted in guestbook |
| XSS (DOM) | Yes | Yes | Client-side injection via document.write |
| CSRF | Yes | Yes | GET-based password change, no token |
| Insecure CAPTCHA | Yes | Yes | Bypass via step parameter |
| Brute Force | Yes | Yes | No rate limiting/lockout |
| Weak Session IDs | Yes | Yes | Session does not rotate |
| CSP Bypass | Yes | Yes | Whitelisted CDNs allow script injection |
| JavaScript | Yes | No (low severity) | Client-side validation only |

## Coverage Notes

- All 14 enumerated modules were tested.
- 13 of 14 modules confirmed vulnerable (JavaScript module has client-side-only validation, low impact).
- Initial access: default DVWA credentials admin:password with CSRF token.
- Critical impact chain: SQLi → credential extraction → File Upload/Command Injection → full server compromise as www-data.
