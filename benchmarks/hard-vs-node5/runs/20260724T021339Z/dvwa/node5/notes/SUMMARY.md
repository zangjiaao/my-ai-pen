# Node5 arm — DVWA lab

**Booked:** 16
**Wall:** ~2201s

## Findings

1. high — Sensitive config file exposure (no authentication required) (`/config/config.inc.php.bak`)
2. high — Public directory listing of /config/ exposes database credentials (`/config`)
3. critical — SQL Injection (UNION-based) in id parameter - /vulnerabilities/sqli/ (`/vulnerabilities/sqli`)
4. high — Command Injection - arbitrary system command execution (`/vulnerabilities/exec`)
5. high — Session fixation - PHPSESSID not regenerated on login (`/login.php`)
6. medium — Weak sequential session IDs (dvwaSession) (`/vulnerabilities/weak_id`)
7. high — Stored Cross-Site Scripting (XSS) in Guestbook (`/vulnerabilities/xss_s`)
8. critical — CSRF - Password change without anti-CSRF token (`/vulnerabilities/csrf`)
9. medium — Brute Force – No CSRF token or rate limiting on login form (`/vulnerabilities/brute`)
10. medium — Directory listing of /hackable/users/ publicly accessible - username enumeration (`/hackable/users`)
11. high — Local File Inclusion (LFI) via page parameter (`/vulnerabilities/fi`)
12. critical — Blind SQL Injection (Boolean + Time-based) in id parameter - /vulnerabilities/sqli_blind/ (`/vulnerabilities/sqli_blind`)
13. medium — No privilege separation between users - identical access levels (`/vulnerabilities/brute`)
14. medium — Broken access control — cross-actor or unauthenticated object access (`/hackable/users`)
15. medium — Insecure CAPTCHA - step parameter bypass (no reCAPTCHA verification on final step) (`/vulnerabilities/captcha`)
16. medium — CSP Bypass via allowlisted external script sources (`/vulnerabilities/csp`)
