---
name: web_baseline
description: "Web 应用基线安全测试。Use when: 测试一个 Web 应用或 API — 适用所有 Web 目标作为第一步测试流程。覆盖信息收集、认证测试、配置检查、注入点发现。"
allowed-tools:
  - execute
  - http_request
  - browser
  - create_candidate_finding
  - confirm_finding
  - reject_finding
  - request_approval
  - report_asset
phase: recon
disable_model_invocation: false
---

# Web 应用基线测试

这是每个 Web 目标的**第一步测试流程**。完成后应产出：攻击面地图 + 候选注入点 + 安全配置问题。

## Step 0: 预检

```bash
# DNS 解析
dig +short TARGET_HOSTNAME
host TARGET_HOSTNAME

# 连通性
curl -sI -k https://TARGET_HOSTNAME/ -o /dev/null -w "%{http_code}"
```

如果目标不可达 → report_blocked。如果有 WAF (检查响应头 `cf-ray`, `x-amzn-requestid` 等) → 记录到应用模型。

## Step 1: 端口扫描

```bash
# 快速常见端口扫描 (先跑 Top 1000)
nmap -sS -sV --top-ports 1000 --min-rate 500 TARGET_IP -oN ${SKILL_DIR}/output/nmap-top1000.txt

# 如果有 Web 端口以外的有趣服务 (SSH/FTP/SMB/数据库) → 记录
```

## Step 2: Web 服务识别

```bash
# 对发现的每个 Web 端口
httpx -u https://TARGET_HOSTNAME:PORT -sc -title -tech-detect -server -cdn -o ${SKILL_DIR}/output/httpx.txt
```

从输出中提取：
- 技术栈指纹 (nginx, Apache, Node.js, PHP 版本等)
- CDN/WAF 检测
- 响应状态码分布

## Step 3: 目录枚举

```bash
# 用常见字典枚举目录和文件
gobuster dir -u https://TARGET_HOSTNAME/ \
  -w /usr/share/wordlists/common.txt \
  -x php,asp,aspx,jsp,html,bak,zip,tar.gz,sql,json,xml \
  -o ${SKILL_DIR}/output/gobuster.txt
```

关注发现：管理后台 (/admin, /manage)、API 文档 (/swagger, /api-docs)、配置文件 (.env, .git, web.config)、备份文件 (.bak, .zip)。

## Step 4: 认证测试

如果有登录功能：

```
# 1. 浏览器登录
browser(action="login", login_url="https://TARGET_HOSTNAME/login", username="...", password="...")
browser(action="save_auth", auth_name="test_user")

# 2. 检查登录后的认证机制
browser(action="navigate", url="https://TARGET_HOSTNAME/")
browser(action="capture_requests")  → 观察使用的认证方式 (Cookie? Bearer Token? JWT?)

# 3. 测试基本认证绕过
http_request(method="GET", url="https://TARGET_HOSTNAME/admin", auth_name=None)
→ 如果 200 返回 = 无需认证即可访问管理功能
```

基础认证检查项：
- 默认凭据测试 (admin/admin, admin/password, guest/guest)
- 密码重置功能是否存在
- 注册功能是否开放
- 会话 Cookie 是否设置了 HttpOnly + Secure + SameSite

## Step 5: 安全头检查

```bash
curl -sI -k https://TARGET_HOSTNAME/ | grep -iE \
  "strict-transport-security|content-security-policy|x-frame-options|\
   x-content-type-options|referrer-policy|permissions-policy"
```

缺失任何安全头 → create_candidate_finding(severity=low, vuln_type=misconfiguration)

## Step 6: 信息泄露检查

```bash
# 常见敏感路径
for path in /.git/HEAD /.env /.DS_Store /robots.txt /sitemap.xml \
            /wp-config.php.bak /web.config.bak /phpinfo.php /server-status; do
  status=$(curl -sk -o /dev/null -w "%{http_code}" "https://TARGET_HOSTNAME$path")
  [ "$status" != "404" ] && [ "$status" != "403" ] && echo "[$status] $path"
done
```

## Step 7: 注入点发现

结合浏览器流量捕获和手动探测：

```
# 从 capture_requests 获取所有含参数的端点
# 对每个参数标注注入类型 → 记录到应用模型
# 这一步为后续 scan 阶段提供精确的攻击面
```

使用 `http_request` 对每个含参端点发送安全探测值(数字 1, 字符串 "test")→记录正常响应作为 baseline → 后续对比用。

## 完成后

调用 `phase_transition` 进入 scan 阶段。
