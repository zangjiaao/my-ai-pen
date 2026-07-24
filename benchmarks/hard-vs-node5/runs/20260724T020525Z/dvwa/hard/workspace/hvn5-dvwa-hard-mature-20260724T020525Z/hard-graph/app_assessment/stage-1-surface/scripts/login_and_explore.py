#!/usr/bin/env python3
"""Log into DVWA, create/reset database, then explore all pages."""
import requests
import re
import sys

BASE = "http://127.0.0.1:8080"

s = requests.Session()
s.headers.update({"User-Agent": "Mozilla/5.0"})

# Step 1: Get login page
print("=== Step 1: Get login page ===")
r = s.get(f"{BASE}/login.php")
print(f"Status: {r.status_code}")
print(f"Cookies: {dict(s.cookies)}")

# Extract CSRF token
match = re.search(r"user_token' value='([^']+)'", r.text)
if not match:
    print("ERROR: Could not find CSRF token")
    print(r.text[:500])
    sys.exit(1)
token = match.group(1)
print(f"CSRF Token: {token}")

# Step 2: Login
print("\n=== Step 2: Login ===")
r = s.post(f"{BASE}/login.php", data={
    "username": "admin",
    "password": "password",
    "Login": "Login",
    "user_token": token
}, allow_redirects=True)
print(f"Final status: {r.status_code}")
print(f"Final URL: {r.url}")
print(f"Cookies: {dict(s.cookies)}")

# Check if login succeeded (should be on setup.php)
if "Login" in r.text and "CSRF token" in r.text:
    print("ERROR: Login failed")
    print(r.text[:500])
    sys.exit(1)
print("Login successful!")

# Step 3: Create/Reset database
print("\n=== Step 3: Create/Reset Database ===")
r = s.post(f"{BASE}/setup.php", data={"create_db": "Create/Reset Database"})
print(f"Status: {r.status_code}")
# Check for success
if "success" in r.text.lower() or "created" in r.text.lower():
    print("Database setup success message found!")
else:
    print("No explicit success message, but continuing...")

# Step 4: Explore all pages - find all .php links
print("\n=== Step 4: Discover all pages ===")
r = s.get(f"{BASE}/setup.php")
# Find all links
links = re.findall(r'href="([^"]+\.php)"', r.text)
print(f"Found links: {links}")

# Also check for JS files, CSS, etc.
all_hrefs = re.findall(r'href="([^"]+)"', r.text)
all_srcs = re.findall(r'src="([^"]+)"', r.text)
print(f"\nAll hrefs: {all_hrefs}")
print(f"All srcs: {all_srcs}")

# Step 5: Visit each discovered page
print("\n=== Step 5: Visit discovered pages ===")
for link in set(links):
    if link.startswith("http"):
        url = link
    else:
        url = f"{BASE}/{link.lstrip('/')}"
    print(f"\n--- Visiting: {url} ---")
    try:
        r = s.get(url, timeout=10)
        print(f"Status: {r.status_code}, Length: {len(r.text)}")
        # Extract menu items from this page
        page_links = re.findall(r'href="([^"]+\.php)"', r.text)
        if page_links:
            print(f"New links found: {page_links}")
        # Look for forms
        forms = re.findall(r'<form[^>]*action="([^"]*)"[^>]*>', r.text, re.I)
        if forms:
            print(f"Forms: {forms}")
    except Exception as e:
        print(f"Error: {e}")

# Step 6: Check for config file
print("\n=== Step 6: Check additional resources ===")
config_urls = [
    "/config/config.inc.php",
    "/config/",
    "/.htaccess",
    "/phpinfo.php",
    "/dvwa/includes/",
    "/dvwa/js/",
    "/hackable/uploads/",
    "/external/",
    "/phpids/",
    "/robots.txt",
]
for path in config_urls:
    url = f"{BASE}{path}"
    try:
        r = s.get(url, timeout=10)
        print(f"{url}: {r.status_code} ({len(r.text)} bytes)")
        if r.status_code == 200 and len(r.text) > 0:
            print(f"  First 200 chars: {r.text[:200].strip()}")
    except Exception as e:
        print(f"{url}: Error - {e}")

print("\n=== Done ===")
