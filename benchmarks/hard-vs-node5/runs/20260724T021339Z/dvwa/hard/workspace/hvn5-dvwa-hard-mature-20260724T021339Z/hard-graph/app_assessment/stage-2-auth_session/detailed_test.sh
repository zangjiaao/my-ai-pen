#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== Login page full response ==="
echo ""
curl -s "$TARGET/login.php" | grep -v '^\s*$' | head -40
echo ""

echo "=== Check security.php full response ==="
echo ""
rm -f /tmp/sec_cookies.txt
# First get a fresh session and login
resp=$(curl -s -c /tmp/sec_cookies.txt "$TARGET/login.php")
token=$(echo "$resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
login_resp=$(curl -s -L -b /tmp/sec_cookies.txt -c /tmp/sec_cookies2.txt \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")
# Now get security page
sec_full=$(curl -s -b /tmp/sec_cookies2.txt "$TARGET/security.php")
echo "$sec_full" | grep -v '^\s*$' | head -50
echo ""
echo "--- Security CSRF token ---"
echo "$sec_full" | grep -oP "value='\K[a-f0-9]+" | head -3
echo ""

echo "=== Change security level ==="
echo ""
sec_token=$(echo "$sec_full" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Sec token: $sec_token"
if [ -n "$sec_token" ]; then
    change_resp=$(curl -s -L -b /tmp/sec_cookies2.txt -c /tmp/sec_cookies3.txt \
        -d "security=medium&seclev_submit=Submit&user_token=${sec_token}" \
        "$TARGET/security.php")
    echo "Change response length: $(echo "$change_resp" | wc -c)"
    echo "$change_resp" | grep -i "security\|level\|message\|medium\|changed" | head -10
    echo ""
    echo "Cookie after change:"
    cat /tmp/sec_cookies3.txt | grep security
    echo ""
    # Check current level
    current_sec=$(curl -s -b /tmp/sec_cookies3.txt -o /dev/null -w "%{cookies}" "$TARGET/security.php" 2>/dev/null || true)
    sec_header=$(curl -s -D - -o /dev/null -b /tmp/sec_cookies3.txt "$TARGET/security.php" 2>&1 | grep -i "^Set-Cookie.*security")
    echo "Security cookie from response headers:"
    echo "$sec_header"
fi
echo ""

echo "=== CSRF token rotation check ==="
echo ""
rm -f /tmp/rot_cookies.txt
# Get login page twice to see if token changes each time
r1=$(curl -s -c /tmp/rot_cookies.txt "$TARGET/login.php")
t1=$(echo "$r1" | grep -oP "value='\K[a-f0-9]+" | head -1)
sleep 0.5
r2=$(curl -s -b /tmp/rot_cookies.txt "$TARGET/login.php")
t2=$(echo "$r2" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token 1: $t1"
echo "Token 2: $t2"
if [ "$t1" = "$t2" ]; then
    echo "Token unchanged (per-session static token)"
else
    echo "Token changed (per-request dynamic token)"
fi
echo ""

echo "=== Check if token is tied to session ==="
echo ""
# Use token from one session in another session
rm -f /tmp/sessA.txt /tmp/sessB.txt
ra=$(curl -s -c /tmp/sessA.txt "$TARGET/login.php")
ta=$(echo "$ra" | grep -oP "value='\K[a-f0-9]+" | head -1)
rb=$(curl -s -c /tmp/sessB.txt "$TARGET/login.php")
tb=$(echo "$rb" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Session A token: $ta"
echo "Session B token: $tb"
# Try using token A in session B
cross_resp=$(curl -s -L -b /tmp/sessB.txt \
    -d "username=admin&password=password&user_token=${ta}&Login=Login" \
    "$TARGET/login.php")
echo "Cross-session token attempt response:"
echo "$cross_resp" | grep -i "message\|token\|failed\|incorrect\|welcome" | head -5
echo ""

echo "=== Check /vulnerabilities/csrf/ for password change ==="
echo ""
csrf_page=$(curl -s -b /tmp/sec_cookies3.txt "$TARGET/vulnerabilities/csrf/")
echo "$csrf_page" | head -60
echo ""

echo "=== Check setup.php for DB reset ==="
echo ""
setup_page=$(curl -s -b /tmp/sec_cookies3.txt "$TARGET/setup.php")
echo "$setup_page" | grep -i "setup\|database\|reset\|create\|button\|token" | head -10
echo ""
setup_token=$(echo "$setup_page" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Setup CSRF token: $setup_token"

