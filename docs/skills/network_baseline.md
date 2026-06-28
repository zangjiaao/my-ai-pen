---
name: network_baseline
description: "主机/内网渗透基线测试。Use when: target 是 IP 地址或 IP 段 (非 URL) — 全面端口扫描、服务识别、弱口令/默认凭据检查、已知漏洞检测"
allowed-tools:
  - execute
  - http_request
  - create_candidate_finding
  - confirm_finding
  - reject_finding
  - request_approval
  - report_asset
phase: recon
disable_model_invocation: false
---

# 主机渗透基线测试

多个 IP 地址的标准化渗透测试流程。每个 IP 独立执行，结果汇总到平台资产库。

## Step 1: 全端口扫描

```bash
# 对每个 target IP (可并行，最多3个同时)
nmap -sS -p- --min-rate 1000 -T4 TARGET_IP -oN ${SKILL_DIR}/output/nmap-TARGET_IP-full.txt

# 对发现的开放端口做服务版本+默认脚本
nmap -sV -sC -p OPEN_PORTS TARGET_IP -oN ${SKILL_DIR}/output/nmap-TARGET_IP-version.txt
```

每发现一个主机 → `report_asset(address=TARGET_IP, asset_type="host", open_ports=[...], services=[...])`

## Step 2: 服务分组

将 Step 1 的输出按服务类型分组：

```
Web 服务 (80,443,8080,8443,...) → 进入 web_baseline 流程
SSH (22) → Step 3a
FTP (21) → Step 3b
SMB (445,139) → Step 3c
数据库 (3306,1433,5432,1521,6379,27017) → Step 3d
其他 (DNS,SMTP,SNMP,LDAP,RDP) → Step 3e
```

## Step 3a: SSH (22)

```bash
# 版本 + 算法
ssh -V TARGET_IP 2>&1
nmap -sV -p 22 --script ssh-auth-methods,ssh-hostkey,ssh2-enum-algos TARGET_IP

# 弱口令测试 (必须授权!)
request_approval(risk_level="destructive", 
  question="是否允许对 SSH 服务进行弱口令测试？",
  proposed_action=f"hydra -l root -P /usr/share/wordlists/top-passwords.txt ssh://TARGET_IP",
  target="TARGET_IP")
```

## Step 3b: FTP (21)

```bash
# 匿名登录
ftp -n TARGET_IP << EOF
user anonymous anonymous
ls
bye
EOF

# 版本检测
nmap -sV -p 21 --script ftp-anon,ftp-bounce,ftp-proftpd-backdoor,ftp-vsftpd-backdoor TARGET_IP
```

如果匿名登录成功 → `create_candidate_finding(severity="medium", vuln_type="misconfiguration", title="FTP 匿名登录允许")`

## Step 3c: SMB (445, 139)

```bash
# 匿名访问 + 共享枚举
smbclient -N -L //TARGET_IP
enum4linux -a TARGET_IP

# 漏洞检测
nmap -p 445 --script smb-vuln-ms17-010,smb-vuln-ms08-067,smb-vuln-cve-2020-0796 TARGET_IP
```

如果 EternalBlue/MS08-067 阳性 → `create_candidate_finding(severity="critical", vuln_type="known_cve")`

## Step 3d: 数据库

```bash
# MySQL (3306) — 空密码测试
mysql -u root -h TARGET_IP -e "SELECT version()" 2>&1

# Redis (6379) — 无认证访问
redis-cli -h TARGET_IP INFO

# MongoDB (27017) — 未授权访问
nmap -p 27017 --script mongodb-databases TARGET_IP

# PostgreSQL (5432)
psql -h TARGET_IP -U postgres -c "SELECT version()" 2>&1
```

## Step 3e: 其他服务

```bash
# DNS (53) — 区域传输
dig AXFR @TARGET_IP domain.name

# SMTP (25) — 用户枚举
smtp-user-enum -M VRFY -U /usr/share/wordlists/usernames.txt -t TARGET_IP

# SNMP (161) — Community 字符串
onesixtyone -c /usr/share/wordlists/snmp-communities.txt TARGET_IP
snmpwalk -v2c -c public TARGET_IP

# RDP (3389) — BlueKeep
nmap -p 3389 --script rdp-vuln-ms12-020,rdp-ntlm-info TARGET_IP

# LDAP (389) — 匿名绑定
ldapsearch -x -H ldap://TARGET_IP -b "" -s base "(objectclass=*)" 2>&1
```

## Step 4: 汇总

按主机汇总所有发现 → 生成资产列表 + 漏洞列表 → `phase_transition` 进入 verify (如需验证弱口令等) 或 report。
