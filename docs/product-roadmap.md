# 产品路线图 — AI 安全运营平台

> 来源: `vision.json` V2.0 / `docs/prd.md` / `docs/architecture.md` / `docs/pentest-node-spec.md`
> 进度审计时间: 2026-06-29
> 当前结论: **MVP Alpha 单节点闭环已通过平台、Node、真实 `/ws`、浏览器 UI、真实 DockerSandbox 自动化验收；MVP 全量仍有 P1/P2 缺口。**

---

## 状态说明

本文件已按当前代码重新校准。此前 roadmap 将几乎所有任务都标为已完成，但代码中很多能力只是设计文档、静态页面、内存原型或未接通的接口。

标记规则：

- `[x]` 已完成：当前代码中有可运行实现支撑。
- `[ ]` 未完成：没有实现，或只有按钮/文档/占位。
- `部分完成`：已有骨架或单向链路，但没有达到 roadmap 原描述。

本次审计主要检查了：

- 平台前端：`platform/frontend/src`
- 平台后端：`platform/backend/app`
- 渗透 Node：`node/pentest_node`
- 部署与靶场：`platform/docker-compose*.yml`、`node/Dockerfile*`
- 产品/架构文档：`docs/prd.md`、`docs/architecture.md`、`docs/pentest-node-spec.md`

注意：PLAID Build 说明要求存在 `docs/product-vision.md`，当前已按 `vision.json` / PRD 补齐；`scripts/validate-vision.js` 仍缺失，无法执行 PLAID 自动校验脚本。

---

## 版本概览

| 版本 | 当前状态 | 核心交付 |
|------|----------|---------|
| MVP | 部分完成 | 平台 Web 原型 + 后端 CRUD/API 骨架 + 节点 WebSocket 联调原型 + 渗透 Node LLM 工具调用原型 |
| Post-MVP | 未开始 | 代码审计 Node、应急响应 Node、CTF Node、威胁情报、多租户、报告中心 |

当前 MVP 不是“平台 + 渗透 Node 全能力”。更准确的说法是：**已有平台和 Node 的端到端雏形，可以注册节点、登录平台、创建会话、通过 WebSocket 下发任务并显示部分 Agent 输出，但完整安全控制、证据链、持久化、授权闭环、独立运行、报告同步等仍未完成。**

---

## MVP 当前真实进度

目标：一个安全团队用 Web 浏览器发起渗透测试、实时观看 Agent 执行过程、干预关键决策、查看结构化结果。

当前状态：**部分达成。**

### 平台前端

- [x] **对话页 — 基础布局**
  - [x] Sidebar + 对话区 + 右侧面板三栏结构已实现。
  - [x] 「新建会话」按钮进入空白对话页。
  - [x] 会话列表按后端返回展示，具备基础状态点。
  - [x] 会话重命名 UI 已实现，后端 PATCH title 会更新并刷新会话列表。
  - [ ] 归档未实现；删除已实现。
  - [x] 次级导航入口已包含资产、漏洞、节点、Skill、知识库、记忆管理。

- [ ] **对话页 — 对话区完整能力**
  - 部分完成：普通文本消息、系统状态、工具输出卡片、漏洞卡片、资产卡片有基础渲染。
  - [ ] Markdown 渲染未实现，当前只是直接显示文本。
  - [x] 工具调用卡片有基础流式输出展示。
  - [x] 漏洞发现卡片有基础展示。
  - [ ] 确认卡片和授权选项已接入；超时倒计时未实现。
  - [ ] 附件上传未实现。
  - [x] 快捷模板按钮已实现。
  - [x] 会话切换时会加载该会话消息。
  - [ ] 多会话消息 buffer、补漏、滚动定位等完整体验未实现。

- [ ] **对话页 — 右侧信息面板完整能力**
  - 部分完成：已有「发现 / 进度 / 待处理」Tab。
  - [x] 发现列表基础展示已实现。
  - [x] 进度面板可显示阶段进度、activeTool，并提供固定 TODO 列表。
  - [ ] 目标资产 Tab 未实现。
  - [ ] 统计、工具调用历史、漏洞详情入口未完整实现。
  - [x] 待处理授权列表已接入 `request_decision`，可授权或取消。
  - [ ] 文件 Tab、只读文件查看未实现。

- [ ] **资产管理页**
  - 部分完成：列表、类型/搜索筛选、详情侧栏、手动添加已实现。
  - [ ] 分页 UI 未实现。
  - [ ] 资产详情中的关联漏洞、历史会话、操作日志未实现。
  - [x] Agent 实时发现资产可通过 WebSocket 写入 Asset 表。
  - [x] Asset 已补 `user_id` 并按当前用户过滤。

- [ ] **漏洞管理页**
  - 部分完成：漏洞列表、等级/状态筛选、详情侧栏、状态 PATCH 已实现。
  - [ ] 分页 UI 未实现。
  - [ ] 详情中的复现步骤、影响范围、状态时间线未完整实现。
  - [ ] 「复测」按钮是空操作，后端没有 `/vulnerabilities/{id}/retest`。
  - [x] Vulnerability 已补 `user_id` 并按当前用户过滤。

- [ ] **节点管理页**
  - 部分完成：节点列表、节点注册、token 生成、token 重置、删除已实现。
  - [ ] 部署指南只有简单环境变量提示。
  - [ ] 节点详情页、配置、版本、指标、历史会话未实现。
  - [ ] 健康状态主要依赖 WebSocket 在线/离线更新，没有完整健康检查指标采集。

- [ ] **Skill / 知识库 / 记忆管理页面**
  - Skill 页面：静态本地数组展示，启用/禁用只改前端 state；没有接后端 Skill API。
  - Skill 后端：有内置列表和自定义 Skill 内存上传接口，但未持久化、未解析文件上传、未接入 Agent 选择。
  - 知识库页面：能调用 `/api/knowledge/search`；后端是固定列表 + substring 搜索。
  - 记忆页面：未调用后端 API；后端记忆是内存列表。
  - `knowledge_search` 工具、向量 + BM25 混合检索、Agent 上下文注入、自动学习都未完成。

### 平台后端

- [ ] **会话管理服务**
  - 部分完成：会话创建、列表、详情、删除、消息列表已实现。
  - [x] 会话状态机已统一为 `created/running/paused/completed/failed/canceled`，PATCH 会校验合法流转，`resumed` 兼容归一为 `running`。
  - [ ] `execution_plan`、`discovered_assets`、`vulns_list`、`agent_state` 没有系统性写入。
  - [x] `POST /conversations/{id}/steer` 会按会话绑定节点转发 `user_steer` / `user_interrupt`，节点不在线时返回 409。

- [ ] **资产引擎**
  - 部分完成：资产 CRUD API 已实现。
  - [ ] JSON Schema 校验未实现。
  - [ ] 资产与 Agent 发现、会话、漏洞的实时关联未实现。

- [ ] **漏洞引擎**
  - 部分完成：漏洞列表、详情、状态/字段 PATCH 已实现。
  - [ ] 漏洞创建 API 未开放给前端/Node WebSocket；实时 `vuln_found` 未写入数据库。
  - [ ] 状态机约束未实现，PATCH 可直接改状态。
  - [ ] 漏洞-会话-证据完整关联未实现。
  - [ ] 复测 API 未实现。

- [ ] **WebSocket 服务**
  - 部分完成：用户 JWT 连接、节点 token 连接、节点在线/离线、用户消息转 `task_assign`、节点消息转发给订阅会话、部分消息持久化已实现。
  - [x] 前端 WebSocket 有自动重连和发送队列。
  - [ ] 后端心跳、ACK、离线消息缓存、重连补传未实现。
  - [x] `request_decision` 已具备前端确认卡、待处理列表和 `user_decision` 回传闭环。
  - [x] `user_steer` / `user_interrupt` 已按会话绑定节点精确路由；用户中断会同步更新会话状态。
  - [ ] RabbitMQ 未集成。

- [ ] **平台 Agent**
  - [ ] 自然语言意图识别未实现；前端只用正则提取 URL，后端直接下发任务。
  - [ ] 会话标题自动生成未实现。
  - [ ] 阶段摘要生成未实现。
  - [ ] 资产/漏洞 Function Call 查询能力未实现。

- [ ] **节点调度**
  - 部分完成：节点注册/发现、轮询选择在线节点、`task_assign` 下发已实现。
  - [ ] 节点能力发现、任务队列、按会话绑定的中断/纠偏转发未完整实现。
  - [ ] 多节点负载/健康策略未实现。

- [ ] **数据库**
  - 部分完成：SQLAlchemy models 覆盖 User、Conversation、Message、Asset、Vulnerability、Node、AuditLog 等。
  - [x] 已创建 Alpha 初始 Alembic migration：`0001_alpha_schema.py`。
  - [ ] 索引优化未落地。
  - [ ] `Event` 模型未看到实现。

- [ ] **认证与权限**
  - 部分完成：email + password JWT 登录、refresh、前端登录页已实现。
  - [ ] OAuth2 Google/GitHub 未实现。
  - [ ] Token refresh 前端自动刷新策略不完整。
  - [ ] 会话按 user_id 隔离已实现。
  - [ ] 节点仍未按用户隔离；资产、漏洞已按用户隔离。
  - [ ] 节点 WebSocket token 认证已实现。
  - [ ] org_id / role 仅 User 上有字段，资源模型未形成多租户隔离。

- [ ] **审计日志**
  - 部分完成：`AuditLog` 模型和查询 API 已实现。
  - [ ] 没有看到登录、会话、资产、漏洞、节点、Agent 操作写入审计日志的调用。
  - [ ] append-only 数据库权限未实现。
  - [ ] 审计浏览 UI 原本不纳入 MVP，但当前 API 已存在；仍缺数据写入和权限策略。

### 渗透测试 Node

- [ ] **Task Intake**
  - 部分完成：平台模式可以接收 `task_assign` 并构造 AgentLoop task dict。
  - [ ] NodeTask 结构、scope 解析、参数校验未按规格实现。
  - [ ] DNS/连通性校验依赖 LLM 提示执行 curl，不是确定性 intake 逻辑。

- [ ] **Policy Engine + Tool Gateway**
  - 部分完成：有 `ToolRegistry`、`execute`、`http_request`、workflow tools。
  - [x] `browser` 工具已在平台模式注册。
  - [ ] `nmap/httpx/nuclei/sqlmap/gobuster/ffuf/curl` 没有独立 ToolSpec，只是通过 shell `execute` 调用。
  - [x] Scope Gate 已在确定性 intake 和 execute 工具中实现最小校验。
  - [x] destructive 风险命令会阻断并等待用户授权。
  - [x] `request_approval` 会等待用户授权/取消结果。

- [ ] **Agent Orchestrator + Workflow Engine**
  - 部分完成：有 precheck/plan/recon/scan/verify/report 阶段提示和 `phase_transition` 工具。
  - [ ] 阶段转换主要依赖 LLM 调工具，不是规格书里的确定性状态机。
  - [ ] checkpoint 持久化、中断恢复、阻塞条件处理未实现。
  - [ ] 反循环、上下文压缩、质量评分、反事实挑战未实现。

- [ ] **Evidence Store**
  - 部分完成：存在 `node/pentest_node/evidence/store.py`。
  - [x] Agent Loop 已将工具输出写入本地 EvidenceStore，并通过 `evidence_created` 同步 evidence_id/raw_ref/summary/hash 到平台。HTTP 请求/响应专用采集仍需继续扩展。
  - [ ] 证据与 Finding / 平台漏洞记录的完整关联未实现。

- [ ] **Finding Verifier**
  - 部分完成：有 `create_candidate_finding`、`confirm_finding`、`reject_finding` workflow tools。
  - [ ] 候选解析、复现验证、去误报、防重复主要依赖 LLM 自律，没有确定性实现。
  - [ ] `confirm_finding` 要求 evidence_ids，但没有强校验证据存在或数量。

- [ ] **Platform Sync**
  - 部分完成：Node 可发送 `status_update`、`tool_output`、`vuln_found`、`asset_discovered`、`request_decision`、task 结束信息。
  - [x] 平台端已将实时 asset/vuln/evidence 入库；证据文件内容仍只保留 raw_ref/summary/hash，未实现二进制文件同步。
  - [ ] `task_complete` 是 Agent 工具触发本地 `_aborted`，外层发送完成摘要；可演示但不完整。

- [x] **Agent Runtime**
  - 已按当前代码实现为 **OpenAI SDK 兼容接口**，支持通过 `base_url` 接 DeepSeek/Ollama/LM Studio/企业兼容服务。
  - [ ] PydanticAI 未使用。
  - [ ] 结构化输出依赖 OpenAI tool calling + workflow tools，未使用 Pydantic 模型强校验。
  - [ ] HITL 中断点未形成等待/恢复闭环。

- [ ] **Node Runtime Adapter**
  - 部分完成：`PlatformWSClient` 和平台模式转发存在。
  - [ ] 统一事件接口、证据/Finding 抽象不完整。
  - [ ] 纠偏队列存在于 AgentLoop，但平台 `steer` API 未接通；WebSocket 的 `user_steer` 也没有调用 current_loop.steer。

- [ ] **沙箱执行**
  - 部分完成：`DockerSandbox` 类和 `node/Dockerfile.sandbox` 存在。
  - [x] 平台模式已切换为 `DockerSandbox`。
  - [x] DockerSandbox 重复 `execute`/`destroy` 方法已清理。
  - [x] DockerSandbox 已接入平台模式并具备工作目录隔离/资源限制，且 `scripts/docker_sandbox_real_smoke.py` 已验证真实容器启动/执行/清理；kill switch 仍未完整实现。

- [ ] **节点配置与部署**
  - 部分完成：Node 有 pyproject、Dockerfile、Dockerfile.sandbox、配置类、平台模式 CLI。
  - [ ] GHCR 发布未完成。
  - [ ] Node docker-compose 一键部署未看到。
  - [ ] `pentest-node` console script 未在 pyproject 中配置。
  - [ ] 健康检查接口文件存在，但未看到服务入口接入。

- [ ] **本地 TUI 界面**
  - 部分完成：Textual TUI 骨架存在。
  - [ ] 未接真实 Agent 运行状态、发现、资产、日志。
  - [ ] Approve/Stop/Detail/Logs/Quit 快捷键未实现。
  - [ ] `attach` / `observe` CLI 未实现。

- [ ] **独立运行模式**
  - [ ] `--standalone` 当前只打印 “not yet implemented”。
  - [ ] `status` / `logs --follow` / `adjust` / `stop` / `resume` CLI 未实现。
  - [ ] 配置文件模式未接入。

- [ ] **离线结果导出与同步**
  - 部分完成：`export_session()` 和 `sync_to_platform()` 函数存在，平台有 `/api/sync/import`。
  - [ ] CLI 未暴露 `export` / `sync` 命令。
  - [ ] 导出内容只有 session/evidence 目录和 summary，不保证包含 assets/vulns/audit 标准结构。
  - [ ] 平台导入端解析逻辑与导出结构不匹配，且不导入 evidence/audit。

- [ ] **凭据安全**
  - 部分完成：`redact.py` 存在。
  - [ ] 凭据仅内存存储、工具输出全链路遮蔽、导出报告遮蔽未系统性接入。
  - [ ] browser 工具里 auth state 只存在函数闭包内存，且每次调用新建浏览器上下文，实际保存/加载能力有限。

- [ ] **JSONL 事件日志**
  - 部分完成：`jsonl_logger.py` 存在。
  - [ ] 未看到 Agent Loop / CLI 运行路径系统性写 JSONL。

### 测试环境与部署

- [x] Docker 漏洞靶场准备：`platform/docker-compose.targets.yml` 包含 DVWA 和 Juice Shop。
- [x] Docker 沙箱镜像文件：`node/Dockerfile.sandbox` 基于 Kali，安装 nmap、httpx-toolkit、gobuster、nuclei、sqlmap、curl、ffuf、whatweb 等。
- [ ] Metasploitable2 未包含。
- [ ] Playwright、mitmproxy 未安装在 `Dockerfile.sandbox` 中。
- [x] 已新增自动化冒烟脚本：`scripts/alpha_smoke.py` 覆盖平台侧绑定/入库/audit/evidence，`scripts/node_alpha_smoke.py` 覆盖节点侧 intake/scope/approval/evidence，`scripts/ws_alpha_smoke.py` 通过 `/api/nodes` 注册 Node 并用真实 `/ws` endpoint 覆盖 JWT 用户连接、node token 连接、task_assign、request_decision/user_decision 回传、task_complete 和 DB 持久化，`scripts/docker_sandbox_smoke.py` 覆盖 DockerSandbox 合约，`scripts/docker_sandbox_real_smoke.py` 覆盖真实容器执行，`scripts/alpha_browser_smoke.py` 覆盖真实前端登录、发起会话、确认卡授权和 Evidence 视图。
- [ ] 平台 docker-compose 有基础服务编排，但未验证端到端生产部署能力；真实 DockerSandbox 已在本机 Docker Desktop `29.4.1` 上通过脚本化验收。

---

## 平台增强（原 V2 并入）当前状态

- [ ] **全量消息卡片**
  - 部分完成：基础 tool/vuln/asset/status/text 卡片存在，部分增强卡片组件文件存在。
  - [ ] `ThinkingCard`、`SummaryCard`、`ScoreboardCard`、`AttackChainCard` 等未接入 `MessageRenderer`。
  - [ ] auth_card / confirm_card 等授权闭环未完成。

- [ ] **Agent 智能增强**
  - [ ] 质量记分牌、低分补测、反事实挑战未实现。
  - [ ] 跨会话记忆未接 Agent。
  - [ ] 敏感信息遮蔽未系统性接入所有工具输出/日志/报告。

- [ ] **知识库**
  - 部分完成：知识库页面和简单搜索 API 存在。
  - [ ] 向量 + BM25 混合检索未实现。
  - [ ] `knowledge_search` 工具未实现。
  - [ ] 检索结果未注入 Agent 上下文。

- [ ] **Skill 管理**
  - 部分完成：10 个 Skill markdown 文件存在，后端有静态 Skill 列表。
  - [ ] 前端未接后端 Skill API。
  - [ ] 自定义上传未持久化，未校验 YAML frontmatter 文件。
  - [ ] Agent 未加载/选择 Skill 文件驱动执行。

- [ ] **记忆管理**
  - 部分完成：后端内存 API 存在。
  - [ ] 前端未接后端 API。
  - [ ] 编辑、筛选、从会话导入未实现。
  - [ ] Agent 自动学习未实现。

- [ ] **节点 Web 控制台**
  - [ ] 未实现。

- [ ] **增强的 Agent 执行监控**
  - 部分完成：右侧进度面板显示阶段、迭代和活跃工具。
  - [ ] 工具调用历史时间线、待确认事项、文件/证据视图未完整实现。

---

## 多节点管理（原 V3 并入）当前状态

- [ ] **多节点管理**
  - 部分完成：平台可注册多个节点，WebSocket 在线节点采用轮询分配。
  - [ ] 健康检查、心跳监控、离线告警未完整实现。
  - [ ] 会话创建时手动选择 Node 未实现。
  - [ ] 自动分配策略非常基础，不考虑能力/负载/健康。

- [ ] **节点内子代理**
  - [ ] 未实现。
  - [ ] 最多 4 个工具并行执行未实现。
  - [ ] 长时间扫描后台执行、子代理结果整合未实现。

- [ ] **共享信息中心**
  - 部分完成：平台有 Asset/Vulnerability 表。
  - [ ] 同一 Node 内多 Session 共享资产库/漏洞库未实现。
  - [ ] 不同 Node 的 Asset/Finding 共享和用户确认写入策略未实现。

---

## Post-MVP

以下能力仍保持 Post-MVP，当前未开始：

- [ ] 代码审计 Node：源码静态分析 → CodeFinding → 渗透 Node 动态验证。
- [ ] 应急响应 Node：事件分析 → Incident + Timeline + IOC 提取 → 渗透 Node 攻击路径验证。
- [ ] CTF Node：CTF 题目资产类型 + 解题 Agent + Writeup 生成。
- [ ] 威胁情报集成：微步在线 / VirusTotal / AlienVault OTX → 统一情报查询接口。
- [ ] 报告中心：渗透测试报告 / 复测报告 / CTF Writeup / 代码审计报告。
- [ ] 多租户与权限体系：RBAC + 组织架构 + 数据隔离。
- [ ] 日志分析 Node + 告警研判 Node。
- [ ] 跨会话智能学习：成功模式复用、自适应工具选择。

---

## 近期修正优先级

### P0：让 MVP 闭环真实可用

- [x] 接通 `request_decision`：Node 请求授权 → 前端确认卡 → 用户选择 → 平台按会话路由回 Node → Node 继续/取消。
- [x] 实时 `asset_discovered` / `vuln_found` / `tool_output` evidence 已入库并关联 user/conversation/node；漏洞 evidence_ids 可持久化，完整证据文件同步仍未实现。
- [x] 将平台模式从 `LocalSandbox` 切到 `DockerSandbox`，修复 DockerSandbox 重复方法与输出解析。
- [ ] 实现确定性 Task Intake：target 解析、scope 校验已完成；DNS/连通性检查仍由 precheck 工具阶段完成。
- [x] 建立 Alembic 初始迁移脚本。
- [x] 修复会话状态机与前端类型不一致问题。
- [x] 完成资产/漏洞的用户隔离字段与查询过滤。

### P1：补齐安全与可观测基础

- [ ] 审计日志写入基础设施，并覆盖登录、会话、资产、漏洞、节点、Agent 操作。
- [ ] 证据存储接入 Agent Loop：工具输出、hash、summary 已接入并有 smoke 覆盖；HTTP 请求/响应与 Finding 引用强校验仍待补。
- [ ] Scope Gate 和风险等级 Gate 接入 execute/http/browser/workflow。
- [ ] 前端接入确认卡、待处理列表、Sonner 通知。
- [ ] 对话消息支持 Markdown 渲染。
- [ ] 漏洞复测 API 和前端按钮接通。

### P2：恢复 roadmap 中被提前勾选的增强能力

- [ ] Skill 前后端接通，支持上传、校验、持久化、启用/禁用，并让 Agent 读取 Skill。
- [ ] 知识库改为持久化检索，并提供 `knowledge_search` 工具。
- [ ] 记忆管理前端接 API，后端改为数据库存储。
- [ ] 独立模式 CLI：`standalone` / `status` / `logs` / `adjust` / `stop` / `resume`。
- [ ] 导出/同步 CLI，并统一导出包和平台导入格式。
- [ ] TUI 接真实运行状态和快捷键操作。

---

## MVP 启动前检查清单真实状态

- [x] 产品方案文档完成：`vision.json`、`docs/prd.md`、`docs/architecture.md`、`docs/pentest-node-spec.md` 存在。
- [x] `docs/product-vision.md` 已补齐；`scripts/validate-vision.js` 仍缺失，未能运行 PLAID vision 校验。
- [x] 关键页面原型已实现：对话页、资产页、漏洞页、节点页等。
- [ ] 关键页面完整交互未完成：确认卡、附件、详情关联、复测、文件面板等。
- [x] 技术栈基本落地：React + FastAPI + PostgreSQL 模型 + WebSocket + Python Node。
- [ ] RabbitMQ 未落地。
- [ ] 通信协议只实现核心子集，ACK、心跳、离线缓存、按会话精确路由未完成。
- [x] Docker 靶场文件包含 DVWA + Juice Shop。
- [x] Kali 沙箱 Dockerfile 存在。
- [x] 沙箱镜像已在平台模式代码路径接入，并通过真实 Docker daemon 完成实际容器运行验证。
- [x] browser 工具已注册到平台模式 Agent；浏览器 UI Alpha smoke 已覆盖平台前端闭环。
- [ ] WAF 检测、速率限制感知、覆盖率追踪、应用模型、验证码/MFA/蜜罐检测、MCP 扩展均未在代码中实现。
- [x] 10 个 Skill markdown 文件存在。
- [ ] Skill 未接入 Agent 执行。
- [x] MVP Alpha 冒烟测试清单和自动化验收脚本已建立。

---

## 下一阶段定义

下一个可验收里程碑建议定义为：

**MVP Alpha：单节点端到端渗透任务闭环**

验收标准：

- 用户登录平台，注册一个 Node。
- Node 使用 DockerSandbox 运行。
- 用户创建会话并输入目标 URL。
- 平台按会话绑定 Node，下发 task_assign。
- Node 完成确定性 intake、scope 校验和至少一个 recon 工具调用。
- 工具输出、资产、候选漏洞、证据写入平台数据库。
- 高风险操作能触发确认卡，用户确认后 Node 才继续执行。
- 会话结束后平台能看到消息、资产、漏洞、证据和审计日志。

当前验收：以上 Alpha 闭环已由 `alpha_smoke.py`、`node_alpha_smoke.py`、`ws_alpha_smoke.py`、`docker_sandbox_smoke.py`、`docker_sandbox_real_smoke.py`、`alpha_browser_smoke.py` 覆盖并通过；仍不代表 MVP 全量、生产 docker-compose、多节点、ACK/心跳/离线补传、完整证据文件同步或 kill switch 已完成。

即便 Alpha 闭环已完成，也不应把“全量消息卡片、多节点、子代理、独立模式、报告同步、知识库/记忆智能增强”标为完成。
