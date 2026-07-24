#!/bin/bash
TARGET="http://127.0.0.1:8080"

# Login and get session
rm -f /tmp/csrf_cookies.txt
resp=$(curl -s -c /tmp/csrf_cookies.txt "$TARGET/login.php")
token=$(echo "$resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
login_resp=$(curl -s -L -b /tmp/csrf_cookies.txt -c /tmp/csrf_cookies2.txt \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")
echo "Logged in"
echo ""

echo "=== CSRF page (password change) - Low security ==="
echo ""
csrf_page=$(curl -s -b /tmp/csrf_cookies2.txt "$TARGET/vulnerabilities/csrf/")
echo "$csrf_page"
echo ""

echo "=== Change password via CSRF ==="
echo ""
csrf_token=$(echo "$csrf_page" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "CSRF token for password change: $csrf_token"
# The form likely has: password_new, password_conf, Change, user_token
echo "Form inputs:"
echo "$csrf_page" | grep -oP 'name=["'\'']?[^"'\'' >]+' | head -20
echo ""

# Try password change
if [ -n "$csrf_token" ]; then
    change_pass_resp=$(curl -s -b /tmp/csrf_cookies2.txt \
        -d "password_new=test123&password_conf=test123&Change=Change&user_token=${csrf_token}" \
        "$TARGET/vulnerabilities/csrf/")
    echo "Password change response:"
    echo "$change_pass_resp" | grep -i "message\|success\|changed\|error\|password" | head -10
    echo ""
    
    # Check if password changed by trying to login with new password
    echo "Testing login with new password..."
    rm -f /tmp/newpw_cookies.txt
    new_resp=$(curl -s -c /tmp/newpw_cookies.txt "$TARGET/login.php")
    new_token=$(echo "$new_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
    new_login=$(curl -s -L -b /tmp/newpw_cookies.txt \
        -d "username=admin&password=test123&user_token=${new_token}&Login=Login" \
        "$TARGET/login.php")
    if echo "$new_login" | grep -q "Welcome"; then
        echo "[!] Password changed successfully to test123!"
    else
        echo "[-] New password didn't work"
        # Try old password
        rm -f /tmp/oldpw_cookies.txt
        old_resp=$(curl -s -c /tmp/oldpw_cookies.txt "$TARGET/login.php")
        old_token=$(echo "$old_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
        old_login=$(curl -s -L -b /tmp/oldpw_cookies.txt \
            -d "username=admin&password=password&user_token=${old_token}&Login=Login" \
            "$TARGET/login.php")
        if echo "$old_login" | grep -q "Welcome"; then
            echo "[+] Old password still works"
        else
            echo "[-] Neither password works!"
        fi
    fi
fi
echo ""

echo "=== Reset security level to low ==="
echo ""
sec_page=$(curl -s -b /tmp/csrf_cookies2.txt "$TARGET/security.php")
sec_token=$(echo "$sec_page" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Sec token: $sec_token"
if [ -n "$sec_token" ]; then
    sec_resp=$(curl -s -L -b /tmp/csrf_cookies2.txt -c /tmp/sec_low.txt \
        -d "security=low&seclev_submit=Submit&user_token=${sec_token}" \
        "$TARGET/security.php")
    echo "Security set to low again"
fi

