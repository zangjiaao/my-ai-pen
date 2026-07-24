#!/usr/bin/env python3
"""Deep DVWA exploration with proper session handling."""
import urllib.request
import urllib.parse
import http.cookiejar
import re
import sys

BASE = "http://127.0.0.1:8080"

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
opener.addheaders = [('User-Agent', 'Mozilla/5.0')]

def fetch(url, data=None):
    if data:
        data_bytes = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=data_bytes)
    else:
        req = urllib.request.Request(url)
    resp = opener.open(req, timeout=15)
    body = resp.read().decode('utf-8', errors='replace')
    return body, dict(resp.info()), resp.status

# Fresh session - get login page
print("=== Fresh Login ===")
body, headers, status = fetch(f"{BASE}/login.php")
match = re.search(r"user_token' value='([^']+)'", body)
token = match.group(1) if match else ""
print(f"Token: {token}")

# Login
body, headers, status = fetch(f"{BASE}/login.php", {
    "username": "admin",
    "password": "password",
    "Login": "Login",
    "user_token": token
})
print(f"Login status: {status}")
print(f"Current URL from headers: {headers.get('', '')}")

# Follow redirect
if status == 302 and 'Location' in headers:
    loc = headers['Location']
    if not loc.startswith('http'):
        loc = BASE + '/' + loc.lstrip('/')
    print(f"Redirect to: {loc}")
    body, headers, status = fetch(loc)
    print(f"After redirect: {status}, {len(body)} bytes")

# Create database
print("\n=== Create DB ===")
body, headers, status = fetch(f"{BASE}/setup.php", {"create_db": "Create/Reset Database"})
print(f"DB create status: {status}, size: {len(body)}")
# Check for success
for line in body.split('\n'):
    if 'success' in line.lower() or 'created' in line.lower() or 'database' in line.lower():
        print(f"  {line.strip()[:150]}")

# Now visit setup.php again to see the full menu
print("\n=== Full menu after DB creation ===")
body, headers, status = fetch(f"{BASE}/setup.php")
# Extract all menu links
menu_items = re.findall(r'<li class="[^"]*"><a href="([^"]+\.php)">([^<]+)</a></li>', body)
print("Menu items:")
for href, title in menu_items:
    print(f"  {title}: {href}")

# Also extract any other php links
all_php = re.findall(r'href="([^"]+\.php)"', body)
print(f"\nAll PHP links in page: {all_php}")

# Check if there's a <select> for security level or permissions
# Look for any interesting content
print("\n=== Interesting content snippets ===")
interesting = re.findall(r'(?:<a href="([^"]+\.php)"[^>]*>([^<]+)</a>|<option[^>]*>([^<]+)</option>|<input[^>]*name="([^"]+)"[^>]*>)', body)
for item in interesting:
    print(f"  {item}")

print("\n=== Checking security.php ===")
body, headers, status = fetch(f"{BASE}/security.php")
print(f"Status: {status}, size: {len(body)}")
title = re.search(r'<title>([^<]+)</title>', body, re.I)
if title:
    print(f"Title: {title.group(1)}")
if "login" in body.lower() and "password" in body.lower():
    print("=> This is the login page (redirected)")

print("\n=== Checking phpinfo.php ===")
body, headers, status = fetch(f"{BASE}/phpinfo.php")
print(f"Status: {status}, size: {len(body)}")
if len(body) > 100:
    print(f"First 300 chars: {body[:300]}...")

print("\n=== Done ===")
