#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== 1. Session Cookie Flags ==="
echo ""
# Get raw response headers
rm -f /tmp/cookies_raw.txt
resp_headers=$(curl -s -D - -o /dev/null -c /tmp/cookies_raw.txt "$TARGET/login.php" 2>&1)
echo "Response headers:"
echo "$resp_headers"
echo ""
echo "Cookies in jar:"
cat /tmp/cookies_raw.txt
echo ""

echo "=== 2. Check if PHPSESSID changes on login ==="
echo ""
rm -f /tmp/pre_cookies.txt /tmp/post_cookies.txt
pre_resp=$(curl -s -c /tmp/pre_cookies.txt "$TARGET/login.php")
pre_phpsessid=$(grep PHPSESSID /tmp/pre_cookies.txt | awk '{print $NF}')
echo "Pre-login PHPSESSID: $pre_phpsessid"

token=$(echo "$pre_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
login_resp=$(curl -s -L -b /tmp/pre_cookies.txt -c /tmp/post_cookies.txt \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")
post_phpsessid=$(grep PHPSESSID /tmp/post_cookies.txt | awk '{print $NF}')
echo "Post-login PHPSESSID: $post_phpsessid"
if [ "$pre_phpsessid" = "$post_phpsessid" ]; then
    echo "SESSION ID NOT CHANGED after login (session fixation possible)"
else
    echo "Session ID changed after login (good - mitigates fixation)"
fi
echo ""

echo "=== 3. Check if PHPSESSID changes on logout ==="
echo ""
rm -f /tmp/logout_cookies.txt
logout_headers=$(curl -s -D - -o /dev/null -b /tmp/post_cookies.txt "$TARGET/logout.php" 2>&1)
echo "Logout response headers:"
echo "$logout_headers"
# Check after logout with same cookie
index_check=$(curl -s -L -b /tmp/post_cookies.txt "$TARGET/index.php")
echo "Post-logout index check (should be login page):"
echo "$index_check" | grep -i "<title>" | head -2
echo ""

echo "=== 4. Test brute force protection on login ==="
echo ""
for i in 1 2 3 4 5; do
    rm -f /tmp/brute_cookies.txt
    brute_resp=$(curl -s -c /tmp/brute_cookies.txt "$TARGET/login.php")
    brute_token=$(echo "$brute_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
    brute_result=$(curl -s -L -b /tmp/brute_cookies.txt \
        -d "username=admin&password=wrongpass$i&user_token=${brute_token}&Login=Login" \
        "$TARGET/login.php")
    echo "Attempt $i: $(echo "$brute_result" | grep -i "failed\|incorrect\|message\|title" | head -3)"
done
echo ""

echo "=== 5. Test login with no CSRF token ==="
echo ""
rm -f /tmp/nocsrf_cookies.txt
curl -s -c /tmp/nocsrf_cookies.txt "$TARGET/login.php" > /dev/null
nocsrf_result=$(curl -s -L -b /tmp/nocsrf_cookies.txt \
    -d "username=admin&password=password&Login=Login" \
    "$TARGET/login.php")
echo "No CSRF token response:"
echo "$nocsrf_result" | grep -i "message\|token\|failed\|incorrect" | head -5
echo ""

echo "=== 6. Test login with empty password ==="
echo ""
rm -f /tmp/empty_cookies.txt
empty_resp=$(curl -s -c /tmp/empty_cookies.txt "$TARGET/login.php")
empty_token=$(echo "$empty_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
empty_result=$(curl -s -L -b /tmp/empty_cookies.txt \
    -d "username=admin&password=&user_token=${empty_token}&Login=Login" \
    "$TARGET/login.php")
echo "Empty password response:"
echo "$empty_result" | grep -i "message\|failed\|incorrect\|title\|welcome" | head -5
echo ""

echo "=== 7. Check security.php (change security level) ==="
echo ""
sec_resp=$(curl -s -b /tmp/post_cookies.txt "$TARGET/security.php")
echo "Security page snippet:"
echo "$sec_resp" | grep -i "security\|level\|option\|select\|csrf\|token\|low\|medium\|high\|impossible" | head -10
echo ""
sec_token=$(echo "$sec_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "CSRF token for security: $sec_token"
echo ""

echo "=== 8. Test changing security level ==="
echo ""
change_resp=$(curl -s -L -b /tmp/post_cookies.txt \
    -d "security=high&seclev_submit=Submit&user_token=${sec_token}" \
    "$TARGET/security.php")
echo "Security change response:"
echo "$change_resp" | grep -i "security\|level\|message\|high\|medium" | head -10
echo ""
# Check cookie after change
new_sec=$(curl -s -b /tmp/post_cookies.txt -o /dev/null -w "%{cookies}" "$TARGET/security.php")
echo "Current security cookie: $(grep security /tmp/post_cookies.txt 2>/dev/null || echo 'checking...')"
cat /tmp/post_cookies.txt | grep security
echo ""

echo "=== 9. Check password change mechanism ==="
echo ""
# Look for password change page - check if there's a dedicated endpoint or if it's in another page
pass_resp=$(curl -s -b /tmp/post_cookies.txt "$TARGET/vulnerabilities/csrf/" 2>/dev/null | head -50)
echo "CSRF page (may contain password change):"
echo "$pass_resp" | head -30
echo ""

# Check if there's a separate password change endpoint
for path in "password.php" "change_password.php" "changepass.php" "account.php" "user.php" "profile.php"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/post_cookies.txt "$TARGET/$path")
    echo "  $path => $code"
done

