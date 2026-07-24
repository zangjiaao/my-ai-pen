#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== Test PHP Session ID via URL (PHPSESSID in URL) ==="
echo ""
# Test if PHP accepts session ID via GET parameter
resp1=$(curl -s -D /tmp/url_sess_headers.txt \
    "$TARGET/login.php?PHPSESSID=url_session_test_1" 2>&1)
echo "Set-Cookie from URL-based session:"
grep -i "^Set-Cookie" /tmp/url_sess_headers.txt || echo "(none)"
echo ""

# Test if we can login with URL-based session
echo "=== Attempt login with URL-specified session ==="
echo ""
resp2=$(curl -s -L -D /tmp/url_sess_headers2.txt \
    "$TARGET/login.php?PHPSESSID=url_session_test_2" 2>&1)
token=$(echo "$resp2" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token: $token"
login_resp=$(curl -s -L -D /tmp/url_sess_headers3.txt \
    "$TARGET/login.php?PHPSESSID=url_session_test_2" \
    -d "username=admin&password=password&user_token=${token}&Login=Login" 2>&1)
echo "Login response cookies:"
grep -i "^Set-Cookie" /tmp/url_sess_headers3.txt || echo "(none)"
if echo "$login_resp" | grep -q "Welcome"; then
    echo "[!] Login successful with URL-specified session ID!"
fi
echo ""

echo "=== Test check if session ID rotates on privilege change ==="
echo ""
# Login properly first
rm -f /tmp/rot_cookies.txt
r=$(curl -s -c /tmp/rot_cookies.txt "$TARGET/login.php")
t=$(echo "$r" | grep -oP "value='\K[a-f0-9]+" | head -1)
l=$(curl -s -L -b /tmp/rot_cookies.txt -c /tmp/rot_cookies2.txt \
    -d "username=admin&password=password&user_token=${t}&Login=Login" \
    "$TARGET/login.php")
pre_sessid=$(grep PHPSESSID /tmp/rot_cookies2.txt | awk '{print $NF}')
echo "Session ID after login: $pre_sessid"

# Change security level from low to medium and back
sec_page=$(curl -s -b /tmp/rot_cookies2.txt "$TARGET/security.php")
sec_token=$(echo "$sec_page" | grep -oP "value='\K[a-f0-9]+" | head -1)
curl -s -L -b /tmp/rot_cookies2.txt -c /tmp/rot_cookies3.txt \
    -d "security=medium&seclev_submit=Submit&user_token=${sec_token}" \
    "$TARGET/security.php" > /dev/null
mid_sessid=$(grep PHPSESSID /tmp/rot_cookies3.txt | awk '{print $NF}')
echo "Session ID after security change: $mid_sessid"

# Change back
sec_page2=$(curl -s -b /tmp/rot_cookies3.txt "$TARGET/security.php")
sec_token2=$(echo "$sec_page2" | grep -oP "value='\K[a-f0-9]+" | head -1)
curl -s -L -b /tmp/rot_cookies3.txt -c /tmp/rot_cookies4.txt \
    -d "security=low&seclev_submit=Submit&user_token=${sec_token2}" \
    "$TARGET/security.php" > /dev/null
post_sessid=$(grep PHPSESSID /tmp/rot_cookies4.txt | awk '{print $NF}')
echo "Session ID after second change: $post_sessid"

if [ "$pre_sessid" = "$mid_sessid" ] && [ "$mid_sessid" = "$post_sessid" ]; then
    echo "Session ID unchanged across privilege/security changes"
fi
echo ""

echo "=== Check if login CSRF token is tied to session ==="
echo ""
rm -f /tmp/sess1.txt /tmp/sess2.txt
# Get two parallel sessions
resp_a=$(curl -s -c /tmp/sess1.txt "$TARGET/login.php")
token_a=$(echo "$resp_a" | grep -oP "value='\K[a-f0-9]+" | head -1)
sessid_a=$(grep PHPSESSID /tmp/sess1.txt | awk '{print $NF}')
echo "Session A: $sessid_a, Token A: $token_a"

resp_b=$(curl -s -c /tmp/sess2.txt "$TARGET/login.php")
token_b=$(echo "$resp_b" | grep -oP "value='\K[a-f0-9]+" | head -1)
sessid_b=$(grep PHPSESSID /tmp/sess2.txt | awk '{print $NF}')
echo "Session B: $sessid_b, Token B: $token_b"

# Try token A with session B (should fail)
echo ""
echo "Cross-session token reuse (token A with session B):"
cross_resp=$(curl -s -L -b /tmp/sess2.txt \
    -d "username=admin&password=password&user_token=${token_a}&Login=Login" \
    "$TARGET/login.php")
echo "$cross_resp" | grep -i "message\|token\|failed\|incorrect\|welcome" | head -5

# Try same session token reuse
echo ""
echo "Reusing token A with session A again:"
reuse_resp=$(curl -s -L -b /tmp/sess1.txt \
    -d "username=admin&password=admin&user_token=${token_a}&Login=Login" \
    "$TARGET/login.php")
echo "$reuse_resp" | grep -i "message\|token\|failed\|incorrect\|welcome" | head -5
echo ""
echo "Note: Token A reused - same token, different password. Check if token rotated."

