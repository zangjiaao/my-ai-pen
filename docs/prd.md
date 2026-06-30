# 产品需求文档 (PRD) — AI 安全运营平台

> 文档角色：PLAID 一等文档，定义 MVP Demo 的产品需求、功能范围和验收标准。架构细节见 `docs/architecture.md`，执行顺序见 `docs/product-roadmap.md`。
> 最近校准：2026-07-01

## 1. 概述

AI 安全运营平台通过平台 Web 工作台和渗透测试 Node，把 Web 应用渗透测试转化为可对话、可观察、可授权、可追溯、可交付的闭环。

当前目标不是生产级多节点安全平台，而是可向客户演示的 MVP Demo。Demo 不能只证明系统能跑预设脚本，还必须证明渗透 Agent 具备最小自治能力：能发现攻击面、记录测试覆盖、选择下一步、复现实证漏洞，并把过程和结果持久化。

MVP Demo 包含三条用户可见闭环：

- 在线平台模式：平台调度 Node 执行任务，结果实时入库和展示。
- 离线独立模式：Node 脱离平台也能完成渗透测试，使用本地 SQLite 和证据目录保存结果。
- 同步导入：Standalone 结果可导入平台，进入同一套资产、漏洞、证据和会话管理体验。

## 2. 用户与核心场景

主要用户是安全工程师和渗透测试工程师。

核心用户故事：

- 作为安全工程师，我希望用自然语言描述目标和测试范围，让 Agent 执行渗透测试。
- 作为安全工程师，我希望 Agent 先识别目标攻击面，再按测试覆盖推进，而不是反复执行同类命令。
- 作为安全工程师，我希望看到 Agent 正在做什么、用了什么工具、发现了什么证据。
- 作为安全工程师，我希望高风险操作必须由我确认，避免 Agent 越界。
- 作为安全工程师，我希望刷新页面、切换页面或重新打开会话后，任务过程和结果仍然完整。
- 作为安全工程师，我希望漏洞和资产进入平台库，后续能查看详情、管理状态和发起复测。
- 作为安全工程师，我希望在客户内网或无平台环境中，Node 也能独立完成测试并导出结果。
- 作为安全工程师，我希望离线测试结果能导入平台，形成统一资产和漏洞沉淀。

## 3. MVP Demo 功能范围

### 3.1 Agent 自治能力

P0：

- Node 必须在正式测试前建立 Attack Surface Inventory，记录 host、URL、method、form、参数、链接、登录状态线索、技术栈和端口服务。
- 每条 attack surface 记录必须绑定来源 evidence 或 tool_run_id，便于复盘。
- Node 必须维护 Coverage Store，记录 `(endpoint, parameter, vuln_type)` 的 tried、passed、failed、skipped 状态。
- Agent 必须使用 coverage 选择未测试项，避免无意义重复。
- Agent phase 使用 intake -> recon -> analysis -> verify -> report -> complete。
- Phase 控制必须表达目标、推荐工具、退出条件和质量门禁，不能只靠硬拒绝导致 Agent 卡死。
- confirmed finding 必须经过 Finding Quality Gate：至少包含 evidence_ids、真实目标 URL、复现请求或 curl、响应证据、影响说明和修复建议。
- 疑似、可能、需要进一步确认的发现不能直接进入 confirmed 漏洞。
- MVP verifier 至少覆盖 DVWA/Juice Shop 可演示的 SQLi、XSS、认证/会话、IDOR/访问控制、敏感信息泄露。

P1：

- coverage 摘要可展示在平台右侧面板和 TUI。
- Agent 可基于 coverage 对用户说明“已测试什么、还没测试什么、下一步为什么这样做”。

### 3.2 平台 Web 工作台

P0：

- 登录、会话列表、新建会话、重命名、删除。
- 会话 ID 展示和复制。
- 三栏对话页：左侧会话导航，中间消息流，右侧信息面板。
- 用户可输入自然语言任务，也可 `@平台Agent` 或 `@渗透Agent` 指定回复对象。
- Agent 气泡显示来源名称，节点改名后会话显示同步更新。
- 用户发送后立即显示 `working` 状态；只有推理模型真实输出思考过程时才显示 Thinking 卡片。
- 消息支持 Markdown、表格、代码块、长文本换行。
- 工具卡片默认收起，可展开；running/done/fail 合并为同一张卡。
- 状态只保留 running、done、fail 三类 UI 标识。

P1：

- 漏洞卡片、资产卡片可点击打开详情弹窗。
- 右侧面板显示发现、进度/TODO、待处理授权、证据列表、coverage 摘要。
- 进入会话优先定位最新消息，生成中自动跟随最新内容。
- 会话消息分页懒加载，刷新和切换页面不丢状态。

### 3.3 资产管理

P0：

- 资产列表、搜索/过滤、手工创建。
- Agent 发现的 host、web_app、service、port 写入平台库。
- 资产详情展示地址、类型、来源、端口、服务、关联漏洞、原始 properties。

P1：

- 展示来源会话、最近扫描时间、端口/服务历史。
- 可从资产详情发起新的测试或复测会话。

### 3.4 漏洞管理

P0：

- 漏洞列表、严重等级、状态、影响资产、来源会话。
- 漏洞详情展示描述、位置、置信度、证据、复现步骤、影响、修复建议。
- 状态流转校验：pending、confirmed、reported、fixed、accepted、false_positive。
- 一键复测：从漏洞创建聚焦复测会话，并在有在线 Node 时派发。

P1：

- 证据详情可从漏洞详情打开。
- 状态更新时间线和复测结果摘要。

### 3.5 证据管理

P0：

- Agent 产生的工具输出和 HTTP trace 生成 Evidence 记录。
- Evidence 至少包含 evidence_id、type、source_tool、tool_run_id、summary、hash、raw_ref、metadata。
- 漏洞确认必须绑定 evidence_ids；缺证据的 confirmed finding 不能直接成为可信漏洞。

P1：

- Evidence 详情弹窗展示工具输出摘要、HTTP 请求/响应摘要、hash、raw_ref、来源工具。
- Demo 版可以只展示摘要和引用；若实现 raw evidence 下载，需明确文件路径和权限边界。

### 3.6 节点管理

P0：

- 平台内置一个 Platform Agent 节点，不需要 Token。
- 用户可注册 Pentest Node，生成 Token。
- Token 默认显示头尾，中间用 `*` 隐藏；支持眼睛图标显示/隐藏、复制、刷新。
- 点击节点卡片打开详情 dialog，展示基础信息、Token、状态。
- 用户可修改节点名称，会话中的 Agent 来源名称同步更新。

P1：

- 展示当前任务、最近心跳、最近失败原因。

### 3.7 平台模式 Pentest Node

P0：

- Node 通过 WebSocket 接收 `task_assign`。
- Node 进入 LLM loop 前执行确定性 intake：target、scope、DNS、TCP、localhost/host.docker.internal 提示。
- Node 使用 DockerSandbox 执行工具。
- 支持 execute、http_request、browser、workflow tools。
- scope gate 阻止越权目标。
- risk gate 对高风险操作发起授权。
- Node 回传 status、tool_output、asset_discovered、vuln_found、evidence_created、checkpoint_update、task_complete、task_error。
- checkpoint 支持平台恢复和继续任务。

P1：

- phase 控制避免错误 phase 重复调用不允许工具。
- 失败进入可恢复路径，错误在会话恢复后仍可见且不重复。

### 3.8 Standalone Node

MVP Demo 必须包含最小独立闭环。

P0：

- CLI 创建任务：`pentest-node standalone --target <url-or-ip> --scope <allow> --output <dir>`。
- 独立模式不依赖平台 WebSocket。
- 独立模式复用同一套 intake、scope gate、risk gate、DockerSandbox、Evidence Gate、Agent loop、attack surface、coverage 和 verifier。
- SQLite 是本地事实源。
- 本地 workspace 保存证据文件。
- CLI 无 TUI 时，高风险授权走终端 prompt。
- 支持 `--resume <session_id>` 从最近 checkpoint 恢复未完成任务。

P1：

- Standalone 完成后生成本地报告摘要。
- 支持 `pentest-node export --session <session_id> --output report.tar.gz`。

### 3.9 TUI

MVP Demo 需要最小 TUI，参考 AIRecon 的 Textual/Rich 实现思路。

P0：

- 使用 Textual + Rich。
- TUI 可观察当前 phase、iteration、active tool、状态。
- TUI 显示 Agent 输出流、工具调用、Findings、Assets、Evidence、Coverage 摘要。
- TUI 支持高风险授权确认，行为与平台确认卡一致。
- TUI 从 SQLite 读取快照，同时订阅运行时事件更新。

不承诺：

- TUI 创建复杂任务。
- 多客户端 attach。
- 后台 daemon。
- 多 session 队列。

### 3.10 Export / Import

P0：

- Standalone 导出包格式统一为 `report.tar.gz`。
- 包内至少包含 `manifest.json`、`conversation.jsonl`、`assets.json`、`vulnerabilities.json`、`evidence.json`、`attack_surface.json`、`coverage.json`、`checkpoints/`、`evidence/`。
- 平台 `/api/sync/import` 导入包后创建 Conversation。
- 导入资产、漏洞、证据、消息、attack surface 摘要和 coverage 摘要，并保持 user/conversation/node/source 关联。
- 导入后可在会话、资产管理、漏洞管理和证据详情查看。

P1：

- 导入过程输出校验错误和导入统计。
- 支持重复导入去重。

### 3.11 报告导出

P1：

- 平台基于会话快照导出 Markdown/HTML。
- 报告包含目标、授权范围、执行时间线、资产、漏洞、证据摘要、coverage 摘要、复现步骤、影响、修复建议和免责声明。

## 4. 数据模型要求

### 4.1 平台 PostgreSQL

核心实体：User、Conversation、Message、Node、Asset、Vulnerability、Evidence、AuditLog。

平台是导入后结果和在线会话结果的统一事实源。Asset、Vulnerability、Evidence 是平台管理对象，不应只存在于消息里。

### 4.2 Node SQLite

Standalone 的本地事实源必须包含：sessions、messages、tool_runs、assets、findings、evidence、approvals、checkpoints、attack_surface、coverage。

Agent 事件先写 SQLite，再分发给 TUI、export 或平台同步适配器。

## 5. 协议要求

平台到 Node：`task_assign`、`user_steer`、`user_interrupt`、`user_input`。

Node 到平台：`status_update`、`tool_output`、`asset_discovered`、`vuln_found`、`evidence_created`、`request_decision`、`checkpoint_update`、`task_complete`、`task_error`。

平台模式、Standalone、TUI、export/import 应尽量复用同一套 Agent event schema，避免双实现。消息必须包含 conversation_id 或 session_id，工具调用必须包含稳定 tool_run_id，用于 UI 合并和恢复去重。

## 6. 非功能需求

- 安全：所有工具目标必须受 scope gate 约束。
- 授权：高风险操作必须由用户确认，平台和 TUI 行为一致。
- 持久化：会话状态、工具结果、证据引用、attack surface、coverage 和错误必须可恢复。
- 可观测：用户能明确知道是平台 Agent 还是渗透 Agent 在回复。
- 可信度：confirmed finding 必须有证据和可复现链路。
- 可演示：DVWA/Juice Shop 应有可复现 benchmark runbook，但 runbook 不能替代自治能力。
- 可导入：Standalone 结果必须能进入平台统一资产/漏洞/证据库。

## 7. 当前不做

- 生产级多节点调度和队列化。
- RabbitMQ、多实例 WebSocket 广播、ACK 离线补传。
- 完整 RBAC、组织、多租户。
- 代码审计、应急响应、日志分析、CTF Node。
- 完整 Skill runtime、知识库/记忆注入、子代理。
- 后台 daemon、多客户端 attach、并发 standalone session 队列。
