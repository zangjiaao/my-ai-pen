#!/usr/bin/env python3
"""Explore DVWA - login, setup DB, enumerate all pages."""
import urllib.request
import urllib.parse
import http.cookiejar
import re
import sys
import ssl

BASE = "http://127.0.0.1:8080"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Cookie handling
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
opener.addheaders = [('User-Agent', 'Mozilla/5.0')]

def get(url):
    req = urllib.request.Request(url)
    resp = opener.open(req, timeout=15)
    body = resp.read().decode('utf-8', errors='replace')
    return body, dict(resp.info())

def post(url, data):
    data_bytes = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=data_bytes)
    resp = opener.open(req, timeout=15)
    body = resp.read().decode('utf-8', errors='replace')
    return body, dict(resp.info())

# Step 1: Get login page
print("=== Step 1: Get login page ===")
body, headers = get(f"{BASE}/login.php")
print(f"Cookies: {[(c.name, c.value) for c in cj]}")

# Extract CSRF token
match = re.search(r"user_token' value='([^']+)'", body)
if not match:
    print("ERROR: No CSRF token found")
    sys.exit(1)
token = match.group(1)
print(f"CSRF Token: {token}")

# Step 2: Login
print("\n=== Step 2: Login ===")
body, headers = post(f"{BASE}/login.php", {
    "username": "admin",
    "password": "password",
    "Login": "Login",
    "user_token": token
})
print(f"Response length: {len(body)}")
if "Location" in headers:
    print(f"Redirect to: {headers['Location']}")
if "CSRF token" in body:
    print("ERROR: Login failed - CSRF issue")
else:
    print("Login seems successful!")

# Follow redirect if needed (login.php -> setup.php)
if "Location" in headers and headers["Location"]:
    redirect_url = headers["Location"]
    if not redirect_url.startswith("http"):
        redirect_url = BASE + "/" + redirect_url.lstrip("/")
    print(f"Following redirect to: {redirect_url}")
    body, headers = get(redirect_url)
    print(f"Final page: {len(body)} bytes")

# Step 3: Create/Reset database
print("\n=== Step 3: Create/Reset Database ===")
body, headers = post(f"{BASE}/setup.php", {"create_db": "Create/Reset Database"})
print(f"Status after DB create: {len(body)} bytes")
if "success" in body.lower() or "created" in body.lower() or "done" in body.lower():
    print("Database setup success!")
else:
    # Maybe it needs a separate session - let's check
    print("Checking response for status...")
    # Print any noticeable messages
    for line in body.split('\n'):
        if 'success' in line.lower() or 'created' in line.lower() or 'database' in line.lower() or 'error' in line.lower():
            print(f"  {line.strip()}")

# Step 4: Get all the .php links from setup page
print("\n=== Step 4: Discover all .php pages ===")
body, _ = get(f"{BASE}/setup.php")
php_links = re.findall(r'href="([^"]+\.php)"', body)
print(f"PHP links: {php_links}")

# Also extract from the page all links/resources
all_links = re.findall(r'href="([^"]+)"', body)
all_src = re.findall(r'src="([^"]+)"', body)
print(f"\nAll hrefs: {all_links}")
print(f"All srcs: {all_src}")

# Step 5: Visit each discovered .php page
print("\n=== Step 5: Visit discovered PHP pages ===")
visited = set()
to_visit = list(php_links)
while to_visit:
    link = to_visit.pop(0)
    if link in visited:
        continue
    visited.add(link)
    if link.startswith("http"):
        url = link
    else:
        url = f"{BASE}/{link.lstrip('/')}"
    
    if url in visited:
        continue
    visited.add(url)
    
    print(f"\n--- Visiting: {url} ---")
    try:
        body, headers = get(url)
        print(f"  Status: {len(body)} bytes")
        # Extract new PHP links
        new_php = re.findall(r'href="([^"]+\.php)"', body)
        for nl in new_php:
            if nl not in visited and nl not in to_visit:
                to_visit.append(nl)
        # Extract forms
        forms = re.findall(r'<form[^>]*action="([^"]*)"[^>]*>', body, re.I)
        if forms:
            print(f"  Forms: {forms}")
        # Print title
        title = re.search(r'<title>([^<]+)</title>', body, re.I)
        if title:
            print(f"  Title: {title.group(1)}")
        # Print short excerpt
        body_stripped = re.sub(r'<[^>]+>', ' ', body)
        body_stripped = re.sub(r'\s+', ' ', body_stripped).strip()
        print(f"  Excerpt: {body_stripped[:150]}")
    except Exception as e:
        print(f"  Error: {e}")

# Step 6: Check for config, uploads, etc.
print("\n=== Step 6: Additional checks ===")
extra_paths = [
    "/config/config.inc.php",
    "/config/",
    "/.htaccess",
    "/robots.txt",
    "/phpinfo.php",
    "/dvwa/includes/",
    "/dvwa/js/",
    "/dvwa/css/",
    "/hackable/uploads/",
    "/external/",
    "/favicon.ico",
    "/instructions.php",
    "/about.php",
    "/security.php",
    "/logout.php",
]
for path in extra_paths:
    url = f"{BASE}{path}"
    try:
        body, headers = get(url)
        print(f"{url}: {len(body)} bytes")
        if len(body) < 500:
            print(f"  Content: {body[:200].strip()}")
    except Exception as e:
        print(f"{url}: Error - {e}")

print("\n=== Done ===")
