#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== CSRF token reuse with same session (correct password) ==="
echo ""
rm -f /tmp/reuse_cookies.txt
r=$(curl -s -c /tmp/reuse_cookies.txt "$TARGET/login.php")
t1=$(echo "$r" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token 1: $t1"
# First login - should succeed
l1=$(curl -s -L -b /tmp/reuse_cookies.txt -c /tmp/reuse_cookies2.txt \
    -d "username=admin&password=password&user_token=${t1}&Login=Login" \
    "$TARGET/login.php")
if echo "$l1" | grep -q "Welcome"; then echo "Login 1: OK"; fi

# Now, already logged in, try the SAME token again with correct password
l2=$(curl -s -L -b /tmp/reuse_cookies2.txt \
    -d "username=admin&password=password&user_token=${t1}&Login=Login" \
    "$TARGET/login.php")
if echo "$l2" | grep -q "Welcome"; then 
    echo "Login 2 (same token): OK - token NOT invalidated after use"
else
    echo "Login 2 (same token): FAILED - token invalidated"
    echo "$l2" | grep -i "message\|failed\|incorrect" | head -3
fi
echo ""

echo "=== Check if 'security' cookie controls access level server-side ==="
echo ""
rm -f /tmp/sec_cookies.txt
r=$(curl -s -c /tmp/sec_cookies.txt "$TARGET/login.php")
t=$(echo "$r" | grep -oP "value='\K[a-f0-9]+" | head -1)
l=$(curl -s -L -b /tmp/sec_cookies.txt -c /tmp/sec_cookies2.txt \
    -d "username=admin&password=password&user_token=${t}&Login=Login" \
    "$TARGET/login.php")

# Get the current cookie
echo "Current cookies:"
cat /tmp/sec_cookies2.txt | grep -v "^#"

# Try to change security level via cookie manipulation (not via form)
echo ""
echo "Manipulating security cookie to 'impossible':"
imp_resp=$(curl -s -b /tmp/sec_cookies2.txt \
    -H "Cookie: PHPSESSID=$(grep PHPSESSID /tmp/sec_cookies2.txt | awk '{print $NF}'); security=impossible" \
    "$TARGET/security.php")
echo "$imp_resp" | grep -i "security level is currently" | head -3

# Hmm, the cookie header we sent might conflict with the cookie jar
# Let's just set the cookie jar to have 'impossible'
echo ""
echo "Cookie jar manipulation test:"
# Use -H to override
imp_check=$(curl -s -H "Cookie: PHPSESSID=$(grep PHPSESSID /tmp/sec_cookies2.txt | awk '{print $NF}'); security=impossible" \
    "$TARGET/vulnerabilities/sqli/")
echo "SQLi page with security=impossible cookie:"
echo "$imp_check" | grep -i "user id\|error\|SQL" | head -5
echo ""

echo "=== Logout - does it destroy server-side session? ==="
echo ""
# First check if session still works after logout
rm -f /tmp/logout_test.txt
r=$(curl -s -c /tmp/logout_test.txt "$TARGET/login.php")
t=$(echo "$r" | grep -oP "value='\K[a-f0-9]+" | head -1)
l=$(curl -s -L -b /tmp/logout_test.txt -c /tmp/logout_test2.txt \
    -d "username=admin&password=password&user_token=${t}&Login=Login" \
    "$TARGET/login.php")
sessid_before=$(grep PHPSESSID /tmp/logout_test2.txt | awk '{print $NF}')
echo "Session ID before logout: $sessid_before"

# Logout
curl -s -b /tmp/logout_test2.txt "$TARGET/logout.php" > /dev/null

# Try to use same session to access protected page
sess_after=$(curl -s -H "Cookie: PHPSESSID=$sessid_before; security=low" \
    "$TARGET/index.php" | grep -i "<title>" | head -1)
echo "Index page with old session after logout: $sess_after"

# Try to access setup.php with old session
setup_check=$(curl -s -H "Cookie: PHPSESSID=$sessid_before; security=low" \
    "$TARGET/setup.php" | grep -i "<title>" | head -1)
echo "Setup page with old session: $setup_check"

