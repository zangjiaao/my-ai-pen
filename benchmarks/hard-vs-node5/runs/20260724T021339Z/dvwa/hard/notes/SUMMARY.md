# Hard arm — mature Hard DVWA (post surface-value fix)

**Booked:** 18
**Wall:** ~2741s
**Terminal:** completed

## Findings

1. high — Database credentials disclosure via config backup file (`http://127.0.0.1:8080/config/config.inc.php.bak`)
2. medium — Directory listing enabled on /config/ and other directories (`http://127.0.0.1:8080/config/`)
3. high — Cross-Site Request Forgery (CSRF) on password change (`http://127.0.0.1:8080/vulnerabilities/csrf/`)
4. medium — PHP info disclosure (`http://127.0.0.1:8080/phpinfo.php`)
5. high — Session ID not rotated after login (session fixation) (`http://127.0.0.1:8080/login.php`)
6. medium — Directory listing enabled on /config/ and other directories (`http://127.0.0.1:8080/config/`)
7. high — No brute force protection on login endpoint (`http://127.0.0.1:8080/login.php`)
8. medium — Weak sequential session IDs in dvwaSession cookie (`http://127.0.0.1:8080/vulnerabilities/weak_id/`)
9. medium — Session cookies lack HttpOnly, Secure, and SameSite flags (`http://127.0.0.1:8080/login.php`)
10. critical — SQL Injection in /vulnerabilities/sqli/ (UNION-based) (`http://127.0.0.1:8080/vulnerabilities/sqli/`)
11. medium — Distribution config file with default database credentials (`http://127.0.0.1:8080/config/config.inc.php.dist`)
12. low — Missing security headers (HSTS, X-Frame-Options, X-Content-Type-Options, CSP) (`http://127.0.0.1:8080/login.php`)
13. medium — CSRF token on login not invalidated after use (`http://127.0.0.1:8080/login.php`)
14. high — Setup database reset page accessible without authentication (`http://127.0.0.1:8080/setup.php`)
15. critical — SQL Injection in /vulnerabilities/sqli/ (boolean-based) (`http://127.0.0.1:8080/vulnerabilities/sqli/`)
16. critical — Blind SQL Injection in /vulnerabilities/sqli_blind/ (`http://127.0.0.1:8080/vulnerabilities/sqli_blind/`)
17. critical — Command Execution (RCE) in /vulnerabilities/exec/ (`http://127.0.0.1:8080/vulnerabilities/exec/`)
18. high — Local File Inclusion (LFI) in /vulnerabilities/fi/ (`http://127.0.0.1:8080/vulnerabilities/fi/`)
