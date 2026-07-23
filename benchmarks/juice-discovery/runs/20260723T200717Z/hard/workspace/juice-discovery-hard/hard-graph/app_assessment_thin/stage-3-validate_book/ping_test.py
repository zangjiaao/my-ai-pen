import urllib.request, json

# Test target accessibility
try:
    r = urllib.request.urlopen('http://127.0.0.1:3010/rest/admin/application-version', timeout=5)
    print(f"Status: {r.status}")
    print(f"Body: {r.read().decode('utf-8')[:500]}")
except Exception as e:
    print(f"Error: {e}")
