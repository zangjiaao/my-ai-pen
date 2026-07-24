#!/bin/bash
TARGET="http://127.0.0.1:8080"

echo "=== Is setup.php accessible without login? ==="
echo ""
# No cookies at all
noauth_setup=$(curl -s "$TARGET/setup.php" | grep -i "<title>" | head -1)
echo "Setup without any cookies: $noauth_setup"
# Check if it has setup form
noauth_setup_full=$(curl -s "$TARGET/setup.php")
if echo "$noauth_setup_full" | grep -q "Create / Reset Database"; then
    echo "[-] Setup page accessible without authentication!"
fi
echo ""

echo "=== Is security.php accessible without login? ==="
echo ""
noauth_sec=$(curl -s -L "$TARGET/security.php" | grep -i "<title>" | head -1)
echo "Security without auth: $noauth_sec"
echo ""

echo "=== Are vulnerability pages accessible without login? ==="
echo ""
for page in "brute" "exec" "csrf" "fi/?page=include.php" "upload" "sqli" "xss_r"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -L "$TARGET/vulnerabilities/$page")
    title=$(curl -s -L "$TARGET/vulnerabilities/$page" | grep -i "<title>" | head -1)
    echo "  $page => $code | $title"
done
echo ""

echo "=== Does the server send HSTS/security headers? ==="
echo ""
curl -s -D - -o /dev/null "$TARGET/login.php" 2>&1 | grep -i "strict-transport\|x-frame\|x-content\|x-xss\|csp\|referrer" || echo "(none found)"
echo ""

echo "=== What auth-related files exist? ==="
echo ""
# Check for common auth files
for f in "config/config.inc.php" "config/config.inc.php.bak" ".htaccess" ".htpasswd"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET/$f")
    echo "  $f => $code"
done
echo ""

echo "=== Check if DVWA has remember-me or autologin ==="
echo ""
# Check login page for remember-me checkbox
curl -s "$TARGET/login.php" | grep -i "remember\|auto\|keep\|stay" || echo "(no remember-me found)"
echo ""

echo "=== Check PHPSESSID lifetime ==="
echo ""
# Check session cookie expiry
curl -s -D - -o /dev/null "$TARGET/login.php" 2>&1 | grep -i "Set-Cookie.*PHPSESSID" | head -1
# Note: no Max-Age or Expires in cookie = session cookie (deleted when browser closes)
echo ""

