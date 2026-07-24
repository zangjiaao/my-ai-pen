#!/bin/bash
# Test DVWA login mechanism

TARGET="http://127.0.0.1:8080"

echo "=== 1. Login page - examine CSRF token and form ==="
echo ""
response=$(curl -s -i "$TARGET/login.php")
echo "$response" | head -60
echo ""
echo "--- Extracted user_token ---"
echo "$response" | grep -oP "value='[a-f0-9]+'" | head -1
echo ""

echo "=== 2. Attempt login with valid admin:password ==="
echo ""
# Get fresh session
rm -f /tmp/cookies1.txt
resp1=$(curl -s -c /tmp/cookies1.txt "$TARGET/login.php")
token1=$(echo "$resp1" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token1=$token1"
rm -f /tmp/cookies2.txt
resp2=$(curl -s -L -b /tmp/cookies1.txt -c /tmp/cookies2.txt \
    -d "username=admin&password=password&user_token=${token1}&Login=Login" \
    "$TARGET/login.php")
echo "Login response length: $(echo "$resp2" | wc -c)"
echo "Cookies after login:"
cat /tmp/cookies2.txt
echo ""
echo "Response preview:"
echo "$resp2" | grep -i "welcome\|failed\|incorrect\|success\|logout" | head -5
echo ""

echo "=== 3. Test logged-in session access ==="
echo ""
index=$(curl -s -b /tmp/cookies2.txt "$TARGET/index.php")
echo "Index page length: $(echo "$index" | wc -c)"
echo "$index" | grep -i "welcome\|logout\|menu\|setup\|welcome" | head -10

echo ""
echo "=== 4. Test invalid login ==="
echo ""
# New session for invalid attempt
rm -f /tmp/cookies3.txt
resp3=$(curl -s -c /tmp/cookies3.txt "$TARGET/login.php")
token3=$(echo "$resp3" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token3=$token3"
rm -f /tmp/cookies4.txt
resp4=$(curl -s -L -b /tmp/cookies3.txt -c /tmp/cookies4.txt \
    -d "username=admin&password=wrongpass&user_token=${token3}&Login=Login" \
    "$TARGET/login.php")
echo "Invalid login response length: $(echo "$resp4" | wc -c)"
echo "$resp4" | grep -i "failed\|incorrect\|error\|welcome\|login" | head -5
echo ""

echo "=== 5. Test login with wrong CSRF token ==="
echo ""
rm -f /tmp/cookies5.txt
resp5=$(curl -s -c /tmp/cookies5.txt "$TARGET/login.php")
token5=$(echo "$resp5" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token5=$token5"
resp6=$(curl -s -L -b /tmp/cookies5.txt -c /tmp/cookies6.txt \
    -d "username=admin&password=password&user_token=INVALIDTOKEN12345&Login=Login" \
    "$TARGET/login.php")
echo "Wrong CSRF token response length: $(echo "$resp6" | wc -c)"
echo "$resp6" | grep -i "failed\|incorrect\|token\|csrf\|error" | head -10
echo ""

echo "=== 6. Test reusing a CSRF token twice ==="
echo ""
rm -f /tmp/cookies7.txt
resp7=$(curl -s -c /tmp/cookies7.txt "$TARGET/login.php")
token7=$(echo "$resp7" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token7=$token7"
# First use - should succeed
resp8=$(curl -s -L -b /tmp/cookies7.txt -c /tmp/cookies8.txt \
    -d "username=admin&password=password&user_token=${token7}&Login=Login" \
    "$TARGET/login.php")
echo "First use succeeded: $(echo "$resp8" | grep -c "logout\|Welcome")"
# Second use with same cookie jar and same token
resp9=$(curl -s -L -b /tmp/cookies8.txt -c /tmp/cookies9.txt \
    -d "username=admin&password=password&user_token=${token7}&Login=Login" \
    "$TARGET/login.php")
echo "Second use response: $(echo "$resp9" | grep -i "failed\|incorrect\|success\|welcome" | head -5)"
echo ""

echo "=== 7. Logout test ==="
echo ""
logout_resp=$(curl -s -b /tmp/cookies2.txt "$TARGET/logout.php")
echo "Logout response length: $(echo "$logout_resp" | wc -c)"
echo "Redirected to: $(curl -s -o /dev/null -w "%{redirect_url}" -b /tmp/cookies2.txt "$TARGET/logout.php")"
echo "After logout, try index:"
after_logout=$(curl -s -b /tmp/cookies2.txt -L "$TARGET/index.php")
echo "$after_logout" | grep -i "login\|username\|password" | head -5
echo ""

echo "=== 8. Session fixation test ==="
echo ""
# Set a known PHPSESSID
rm -f /tmp/cookies10.txt
echo -e "127.0.0.1:8080\tFALSE\t/\tFALSE\t0\tPHPSESSID\tfixed_session_12345" > /tmp/cookies10.txt
echo -e "127.0.0.1:8080\tFALSE\t/\tFALSE\t0\tsecurity\tlow" >> /tmp/cookies10.txt
resp10=$(curl -s -b /tmp/cookies10.txt "$TARGET/login.php")
echo "Using fixed PHPSESSID: got login page (length: $(echo "$resp10" | wc -c))"
token10=$(echo "$resp10" | grep -oP "value='\K[a-f0-9]+" | head -1)
resp11=$(curl -s -L -b /tmp/cookies10.txt -c /tmp/cookies11.txt \
    -d "username=admin&password=password&user_token=${token10}&Login=Login" \
    "$TARGET/login.php")
echo "Login with fixed session response: $(echo "$resp11" | grep -i "failed\|welcome\|success\|incorrect" | head -5)"
echo "PHPSESSID after login:"
cat /tmp/cookies11.txt | grep PHPSESSID
echo ""

