# 产品路线图 — AI 安全运营平台

> 来源: `vision.json` V2.0 | 生成时间: 2026-06-28
> 详细设计参考: `docs/pentest-node-spec.md` + `docs/architecture.md` §3

---

## 版本概览

| 版本 | 主题 | 核心交付 |
|------|------|---------|
| **MVP** 🔴 | 平台 + 渗透 Node 全能力 | 完整平台 Web + 渗透 Node 全能力 + 多节点管理 + 子代理并行 |
| **Post-MVP** | 扩展节点 + 平台化 | 代码审计 Node / 应急响应 Node / CTF Node / 情报 / 多租户 |

**MVP = 原 V1 + V2 + V3（去掉代码审计/应急响应 Node）合并而成。** 目标是让平台具备可演示的完整体验——多节点管理、渗透 Node 全能力、完整的 UI 和消息卡片体系。

---

## MVP 🔴 当前

**目标**：一个安全团队用 Web 浏览器就能发起渗透测试、实时观看 Agent 执行过程、干预关键决策、查看结构化结果。

### 平台前端

- [ ] **对话页 — Sidebar**
  - [x] 全局布局：Sidebar + 对话区 + 右侧面板三栏结构
  - [x] 「创建会话」按钮（不弹窗，直接进入对话页；用户在输入框用自然语言描述测试意图）
  - [x] 会话列表（统一列表，按最后活跃时间倒序，不分組）
  - [x] 会话状态视觉标识（运行中/排队中/等待用户确认/失败/完成）
  - [ ] 会话操作：重命名、归档、删除
  - [x] 次级导航入口：资产管理、漏洞管理、节点管理

- [ ] **对话页 — 对话区**
  - [x] 文本消息渲染（Markdown 支持）
  - [ ] 系统通知消息（节点上线/离线、任务开始/结束/异常）
  - [x] 工具调用卡片（工具名称、命令、实时流式输出、状态、耗时）
  - [x] 漏洞发现卡片（等级标签、标题、位置、置信度、查看详情按钮）
  - [ ] 确认卡片（问题描述、选项按钮、超时倒计时）
  - [x] 对话区底部输入框 + 附件上传 + 快捷指令
  - [ ] 会话切换时对话区内容刷新

- [ ] **对话页 — 右侧信息面板**
  - [x] Tab 切换框架
  - [ ] Agent 状态 Tab（当前阶段、当前工具、Agent 状态、工具调用历史）
  - [x] 发现漏洞 Tab（漏洞列表、等级统计、查看详情入口）
  - [ ] 目标资产 Tab（目标信息、开放端口/服务列表、一键纳入资产）

- [ ] **资产管理页**
  - [x] 资产列表（表格展示 + 分页）
  - [ ] 资产筛选（按类型、标签、业务系统）
  - [ ] 资产详情面板（基本信息、关联漏洞、历史会话、操作日志）
  - [ ] 手动添加资产表单
  - [ ] Agent 发现资产自动入库（标记来源）

- [ ] **漏洞管理页**
  - [x] 漏洞列表（表格展示 + 分页 + 等级颜色标识）
  - [ ] 漏洞筛选（按等级、状态、资产、时间范围）
  - [ ] 漏洞详情面板（描述、复现步骤、POC、影响范围、修复建议、状态时间线）
  - [ ] 漏洞状态流转（待确认→已确认→已报告→已修复→接受风险）
  - [ ] 「发起复测」按钮（一键创建复测会话）

- [x] **节点管理页**
  - [x] 节点列表（名称、ID、类型、健康状态、IP、资源使用率、当前会话数）
  - [x] 节点注册（生成接入 Token + 部署指南）
  - [ ] 节点详情（配置、版本、指标、历史会话）

### 平台后端

- [x] **会话管理服务**
  - [x] 会话 CRUD API
  - [x] 会话状态机（created→running→paused→completed→failed）
  - [ ] 会话上下文存储（execution_plan, discovered_assets, vulns_list, agent_state）

- [x] **资产引擎**
  - [x] 资产 CRUD API
  - [ ] 资产属性 JSON Schema 校验
  - [ ] 资产-Agent发现关联

- [x] **漏洞引擎**
  - [x] 漏洞 CRUD API
  - [x] 漏洞状态机 + 状态流转 API
  - [ ] 漏洞-会话-证据关联

- [x] **WebSocket 服务**
  - [x] 双向消息通道（按会话 ID 路由）
  - [x] 心跳 + 断线重连
  - [ ] 消息持久化（离线缓存+重连补传）
  - [x] 节点注册/认证

- [x] **平台 Agent**
  - [x] 自然语言意图识别 → 会话类型 + 节点路由
  - [x] 会话标题自动生成
  - [x] 阶段摘要生成
  - [x] 资产/漏洞数据查询能力（Function Call 方式，调用平台 REST API）

- [x] **节点调度**
  - [x] 节点注册/发现
  - [x] Task 分配（task_assign）
  - [x] 用户中断指令转发

- [x] **数据库**
  - [x] PostgreSQL Schema 创建（Asset, Vulnerability, Conversation, Message, Node, Event, AuditLog）
  - [ ] 索引优化
  - [x] 迁移脚本

- [x] **认证与权限（MVP 最小壳）**
  - [x] JWT 登录（email+password 或 OAuth2 Google/GitHub）
  - [x] 前端登录页 + Token 刷新
  - [x] 会话级别访问隔离（用户只能看到自己的会话/资产/漏洞）
  - [x] 节点 WebSocket Token 认证（已在通信设计中，确认实现）
  - [x] 数据库预留 org_id / role 字段（V5 多租户用，MVP 不用）

- [x] **审计日志**
  - [x] `audit_log` 表创建 + append-only 权限（INSERT/SELECT 无 UPDATE/DELETE）
  - [ ] 人的操作写入：login/logout/session.create/vuln.status_change/approval/asset.crud
  - [ ] Agent 操作写入：task/tool.execute/finding.create+confirm+reject/asset.discover
  - [ ] 系统事件写入：node.connect+disconnect/system.error
  - [x] 审计查询/浏览 UI 不纳入 MVP（V2 补充）

### 渗透测试 Node

- [x] **Task Intake**
  - [x] 接收 task_assign 消息
  - [x] NodeTask 结构构建
  - [ ] Scope 与参数校验

- [x] **Policy Engine + Tool Gateway**
  - [x] 工具注册（nmap, httpx, nuclei, sqlmap, gobuster, ffuf, curl）
  - [x] ToolSpec Schema 定义（参数、风险等级、超时、Parser）
  - [x] Scope 校验 → 非 scope 内目标拒绝
  - [x] 风险等级判断 → 高风险工具触发 ApprovalRequest
  - [x] 命令构建 → 工具沙箱执行

- [ ] **Agent Orchestrator + Workflow Engine**
  - [ ] precheck 阶段：目标格式/DNS/连通性校验
  - [ ] plan 阶段：Playbook 选择 + TaskPlan 生成
  - [ ] recon 阶段：nmap 端口扫描 + httpx 服务识别 + gobuster 目录枚举
  - [ ] scan 阶段：nuclei 模板扫描 + sqlmap 注入检测 + 配置检查
  - [ ] verify 阶段：候选 Finding 复现验证 + 交叉工具验证
  - [ ] report 阶段：ConfirmedFinding 同步 + 阶段摘要生成
  - [ ] checkpoint：每阶段持久化状态，支持中断恢复
  - [ ] 状态机流转 + 阻塞条件处理

- [x] **Evidence Store**
  - [x] 原始工具输出存储（stdout/stderr）
  - [x] 请求/响应对存储
  - [x] 证据哈希 + 摘要生成

- [ ] **Finding Verifier**
  - [x] 候选 Finding 输出解析
  - [ ] 漏洞复现验证
  - [ ] 去误报逻辑
  - [x] 防重复检测

- [ ] **Platform Sync**
  - [ ] status_update 消息发送
  - [ ] tool_output 流式推送
  - [ ] vuln_found 消息（含证据）
  - [ ] asset_discovered 消息
  - [ ] request_decision 消息
  - [ ] task_complete/task_error 消息

- [x] **Agent Runtime（PydanticAI/LiteLLM）**
  - [x] LiteLLM 集成 (chat + stream)
  - [x] 工具 Schema 定义
  - [ ] 结构化输出（TaskPlan, CandidateFinding, ConfirmedFinding）
  - [x] HITL 中断点 (steer/interrupt/confirm)

- [ ] **Node Runtime Adapter**
  - [x] 平台协议适配层 (WS client)
  - [x] 统一事件接口
  - [ ] 证据/Finding 接口抽象

- [x] **沙箱执行**
  - [x] Docker 环境准备（Kali 工具镜像）
  - [x] 沙箱 Runner 实现（资源限制、超时、kill switch）
  - [x] 工作目录隔离

- [x] **节点配置与部署**
  - [x] Docker 镜像构建 + 发布到 GHCR
  - [x] docker-compose.yml 一键部署
  - [x] 配置文件（平台地址、Token、节点类型、工具路径、资源限制）
  - [x] CLI 入口 (`pentest-node` 命令)
  - [ ] 健康检查接口

- [ ] **本地 TUI 界面**
  - [ ] 基于 Textual (Python) 构建独立模式 TUI
  - [ ] 面板：Agent对话区 / 发现列表(按等级) / 资产摘要 / 状态(阶段+进度+活跃工具)
  - [ ] 快捷键：Approve(响应授权)、Stop(安全停止)、Detail(展开Finding)、Logs(原始日志)、Quit(不停止任务)
  - [ ] `pentest-node attach` 重新连接到后台任务
  - [ ] `pentest-node observe` 平台模式下只读观察

- [ ] **独立运行模式**
  - [ ] `pentest-node standalone` CLI 子命令（脱离平台运行）
  - [ ] 配置文件模式 (`--config engagement.yaml`)
  - [ ] 运行时观测：`pentest-node status`、`pentest-node logs --follow`
  - [ ] 运行时调整：`pentest-node adjust`（修改 scope/凭据/策略）
  - [ ] 运行时中止：`pentest-node stop`（安全停止在最近检查点）
  - [ ] 运行时恢复：`pentest-node resume`

- [x] **离线结果导出与同步**
  - [x] `pentest-node export` 生成 report.tar.gz（含 summary+assets+vulns+evidence+audit）
  - [x] `pentest-node sync` 将离线结果同步到平台（REST API 导入）
  - [x] 平台导入端：接收 tar.gz → 创建会话 → 导入资产/漏洞/审计日志

- [x] **凭据安全**
  - [x] 凭据仅存内存，不写磁盘
  - [x] 工具输出中凭据自动遮蔽（redact 模块）
  - [x] 导出报告中不包含明文凭据

- [x] **JSONL 事件日志**

### 测试环境

- [ ] Docker 漏洞靶场准备（DVWA, Metasploitable2 等）
- [ ] MVP 验收标准冒烟测试清单

---

### 平台增强 (原 V2 并入)

- [ ] **全量消息卡片**
  - [ ] P1 消息卡片：Agent 摘要卡片 (summary_card)、阶段指示器 (step_indicator)、授权卡片 (auth_card)
  - [ ] P2 消息卡片：资产发现卡片 (asset_card)、扫描摘要卡片
  - [ ] Agent 思考卡片 (thinking_card) — 可折叠，展示 Agent 决策推理过程
  - [ ] 漏洞利用链卡片 (attack_chain_card) — 多漏洞串联攻击路径可视化
  - [ ] 质量记分牌 (scoreboard_card) — 每阶段三维自评（证据质量/可复现性/覆盖率）

- [ ] **Agent 智能增强**
  - [ ] 质量记分牌：每阶段结束三维自评 → 低于 60 分自动补充测试
  - [ ] 反事实挑战：≥3 个 Finding 时主动质疑假设 → 防止过早下结论
  - [ ] 敏感信息遮蔽：工具输出/日志/报告/跨会话记忆中的凭据自动替换 ***REDACTED***
  - [ ] 跨会话记忆：用户偏好/客户技术栈/特殊配置自动记忆 → 下次会话生效

- [ ] **知识库**
  - [ ] 内置知识源：CVE/NVD + OWASP + PortSwigger Research + 工具手册
  - [ ] `knowledge_search` 工具：向量 + BM25 混合检索
  - [ ] 知识库管理页：搜索/浏览/团队贡献条目
  - [ ] 检索结果注入 Agent 上下文

- [ ] **Skill 管理**
  - [ ] Skill 管理页：卡片网格 + 启用/禁用 + 查看详情 + 上传自定义 Skill
  - [ ] 内置 10 个 Skill + 支持用户上传 YAML frontmatter 格式
  - [ ] 版本标记与更新

- [ ] **记忆管理**
  - [ ] 记忆管理页：列表 + 搜索/筛选 + 编辑/删除
  - [ ] 记忆作用域：个人 / 团队 / 全局
  - [ ] Agent 自动学习 + 用户手动添加 + 从会话导入
  - [ ] 右侧信息面板（操作中心）
    - [ ] Tab 1「发现」：漏洞列表（点击→详情 Dialog：详情/发现过程/证据/修复建议）
    - [ ] Tab 2「进度」：阶段进度条 + Agent 自动 TODO 列表（已完成/进行中/待开始+统计数据）
    - [ ] Tab 3「待处理」：等待授权的操作列表，点击跳转到对话区确认卡片
    - [ ] Tab 4「文件」：Agent 创建的脚本/POC/工具输出文件列表，点击在主区域打开只读 Tab
  - [ ] Sonner 全局通知：Agent 等待决策时弹出，点击自动切换会话+滚动定位；超时前 1 分钟再次提醒
  - [ ] 漏洞详情 Dialog (640px)：详情/发现过程/证据/修复建议 四个子 Tab

- [ ] **节点 Web 控制台**
  - [ ] 节点本地 Web 控制台（性能指标、活跃任务、工具清单、日志查看）
  - [ ] 安全意识：默认关闭、需授权开启、scope 校验 + 操作记录

- [ ] **增强的 Agent 执行监控**
  - [ ] 实时 Agent 状态面板（阶段、进度、活跃工具、待确认事项）
  - [ ] 工具调用历史时间线

### 多节点管理 (原 V3 并入，不含代码审计/应急响应 Node)

- [ ] **多节点管理**
  - [ ] 平台支持注册多个渗透 Node
  - [ ] 节点健康检查 + 心跳监控 + 离线告警
  - [ ] 会话创建时选择/自动分配 Node

- [ ] **节点内子代理 (Subagent)**
  - [ ] 同一步内最多 4 个工具并行执行（已设计）
  - [ ] 长时间扫描后台执行，不阻塞 Agent 主推理链路
  - [ ] 子代理结果回传后 Agent 自动整合

- [ ] **共享信息中心**
  - [ ] 同一 Node 内多个 Session 共享资产库和漏洞库
  - [ ] 不同 Node 通过平台数据库共享 Asset/Finding（V2 阶段只读，写操作需用户确认）

### 测试环境

- [x] Docker 漏洞靶场准备（DVWA + Juice Shop，docker-compose 一键启动）
- [ ] MVP 验收标准冒烟测试清单

---

## Post-MVP

以下能力在 MVP 之后按优先级迭代：

- **代码审计 Node**：源码静态分析 → CodeFinding → 渗透 Node 动态验证
- **应急响应 Node**：事件分析 → Incident + Timeline + IOC 提取 → 渗透 Node 攻击路径验证
- **CTF Node**：CTF 题目资产类型 + 解题 Agent + Writeup 生成
- **威胁情报集成**：微步在线 / VirusTotal / AlienVault OTX → 统一情报查询接口
- **报告中心**：渗透测试报告 / 复测报告 / CTF Writeup / 代码审计报告 → 报告状态管理
- **多租户与权限体系**：RBAC + 组织架构 + 数据隔离
- **日志分析 Node** + **告警研判 Node**
- **跨会话智能学习**：成功模式复用、自适应工具选择

---

## MVP 启动前检查清单

- [x] 产品方案文档完成 (plan.docx → vision.json + PRD)
- [ ] 关键页面线框图确认（对话页、资产页、漏洞页）
- [x] 技术栈最终确认（React + shadcn/ui + FastAPI + PostgreSQL + RabbitMQ）
- [x] 通信协议与消息 Schema 最终确认
- [ ] Docker 漏洞靶场环境准备
  - [ ] DVWA (`vulnerables/web-dvwa`) — 端口8080，覆盖 SQLi/XSS/CSRF/命令注入
  - [ ] OWASP Juice Shop (`bkimminich/juice-shop`) — 端口3000，覆盖 SQLi/XSS/JWT/IDOR/SSRF
  - [ ] docker-compose.yml 一键启动两个靶场 + 网络互通
- [x] Docker 沙箱镜像构建
  - [x] 基于 `kalilinux/kali-rolling` 定制 `pentest-sandbox` 镜像
  - [x] 预装 CLI 工具：nmap, nuclei (+templates), sqlmap, gobuster, ffuf, httpx, curl, whatweb
  - [x] 预装浏览器：Playwright + headless Chromium (+ deps)
  - [x] 预装代理：mitmproxy（HTTP 拦截和请求捕获）
  - [ ] 预置常用字典（/usr/share/wordlists/）
  - [x] 持久容器 + exec 模式（避免每次冷启动 3-5s）
  - [x] 资源限制：mem_limit=2g, cpu_quota=80000, cap_drop=ALL + cap_add=NET_RAW

- [ ] 浏览器自动化 (Playwright)
  - [ ] browser 工具实现：navigate, login, click, type, screenshot, save_auth, load_auth, capture_requests
  - [ ] 自动登录：识别登录表单→填写→提交→检测成功/失败
  - [ ] 网络请求捕获：自动记录所有 XHR/fetch/document 请求
  - [ ] 多账号认证状态管理 (AuthManager)：保存/加载/切换 auth_state

- [ ] 认证会话管理
  - [ ] AuthManager：注册凭据→登录→保存 Cookie→自动注入后续请求
  - [ ] http_request 自动携带认证 Cookie（auth_name 参数切换账号）
  - [ ] 认证失效检测 (401/403) + 自动重登
  - [ ] 凭据遮蔽：工具输出和报告中自动替换为 ***REDACTED***

- [ ] Web 应用测试工作流
  - [ ] 浏览器登录+认证捕获 → 应用探索+请求收集 → 端点分析+注入点提取
  - [ ] 参数测试：重放请求 → 替换参数为 payload → 对比响应
  - [ ] 多账号越权测试：admin 浏览→viewer 浏览→对比可访问端点→尝试跨权限访问
  - [ ] 带认证的自动化扫描：nuclei/sqlmap 使用已捕获的 Cookie

- [ ] WAF 检测与绕过
  - [ ] WAFDetector：HTTP 头指纹 + 响应行为 + 主动探测三级检测
  - [ ] 已知 WAF 指纹库：Cloudflare, AWS WAF, ModSecurity, 阿里云, 长亭, 腾讯云
  - [ ] 自动测试绕过手段 (大小写/编码/空字节/Content-Type切换)
  - [ ] 检测结果注入 Agent 上下文 (WAF名称/置信度/可用绕过/影响)

- [ ] 速率限制感知
  - [ ] http_request 内置限速检测：429/Retry-After/X-RateLimit-Remaining/503
  - [ ] 每 host 独立限速状态 (RateLimit: min_interval, cooldown_until)
  - [ ] 自动等待 + 上下文注入 ("目标有速率限制，最小间隔 X 秒")

- [ ] 覆盖率追踪
  - [ ] CoverageStore: (endpoint_pattern, param_name, vuln_type) 三元组去重
  - [ ] 工具执行前自动查表跳过已测组合
  - [ ] 每轮上下文注入覆盖率摘要 (已测 X 组合, 待测: ...)

- [ ] 应用模型
  - [ ] ApplicationModel: 端点→认证角色→参数→WAF行为 实时图谱
  - [ ] 每轮上下文注入结构化端点地图 (替代纯文本摘要)
  - [ ] 为后续 V3 跨节点协同预留接口

- [ ] 验证码/MFA/蜜罐感知
  - [ ] LoginChallengeDetector: 检测 CAPTCHA/reCAPTCHA/hCaptcha/Turnstile + MFA/TOTP
  - [ ] 遇到挑战时生成 request_user_input 而非报 login failed
  - [ ] HoneypotDetector: 负向测试时检测蜜罐字段+timing 异常

- [ ] MCP 工具扩展 (MVP 预留接口)
  - [ ] MCPAdapter: 启动外部 MCP 服务器 → 发现工具 → 注册到 ToolRegistry
  - [ ] MVP 不依赖外部 MCP，接口预留用于社区工具生态

- [ ] Skill 库 (MVP 至少 10 个)
  - [x] `web_baseline` — Web 应用基线测试 (recon)
  - [x] `network_baseline` — 主机/内网渗透基线 (recon)
  - [x] `sql_injection` — SQL 注入检测与验证 (scan)
  - [x] `xss` — 跨站脚本检测 (scan)
  - [x] `auth_test` — 认证/会话/JWT/越权测试 (scan)
  - [x] `ssrf` — 服务端请求伪造检测 (scan)
  - [x] `idor` — 越权访问专项测试 (scan)
  - [x] `file_upload` — 文件上传漏洞检测 (scan)
  - [x] `api_test` — REST/GraphQL API 安全测试 (scan)
  - [x] `ssti` — 服务端模板注入检测 (scan)
- [ ] 渗透测试 Node CLI 原型验证
- [ ] MVP 里程碑计划排期与人员分工
