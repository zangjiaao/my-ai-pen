# Product Vision — AI 安全运营平台

> 文档角色：PLAID 一等文档，描述产品方向、MVP 边界和成功标准。技术细节见 `docs/prd.md` 与 `docs/architecture.md`，执行计划见 `docs/product-roadmap.md`。
> 最近校准：2026-07-01

## 产品定位

AI 安全运营平台是一个以自然语言对话为核心入口的安全运营系统。平台负责会话、资产、漏洞、证据、节点调度和用户交互；渗透测试 Node 负责具体工具执行、Agent 决策、安全边界、攻击面发现、测试覆盖和证据采集。

产品的长期方向是让安全团队把渗透测试、漏洞验证、复测、报告沉淀和知识复用都放进一个可观测、可干预、可追溯的工作台。当前阶段必须先把单节点渗透测试闭环做成可演示、可复现、可信任的 MVP。

这里的“可信任”不是指能按固定 runbook 跑出预期结果，而是指 Agent 能自主理解目标攻击面、推进未覆盖测试、用证据确认漏洞，并让用户能复盘它为什么得出这个结论。

## 核心问题

安全团队在渗透测试和漏洞验证中经常遇到：

- 工具链分散，执行过程难以复盘。
- 专家经验强依赖，低价值重复操作多。
- Agent 容易重复测试同一端点，或者基于不完整上下文给出结论。
- 漏洞结论与证据文件割裂，报告整理成本高。
- Agent 行为不可观测，用户难以判断它是否真的执行了验证。
- 离线或客户内网场景无法完全依赖平台在线调度。

## 目标用户

主要用户是安全工程师和渗透测试工程师。他们需要用自然语言发起测试，观察 Agent 执行过程，在高风险动作前授权，并获得可管理、可复测、可导出的漏洞结果。

次要用户包括安全运营团队管理者、代码审计工程师和应急响应工程师。当前 MVP 不覆盖这些场景的专业 Node，但数据模型和平台信息中心要为后续扩展预留空间。

## MVP 分层

### MVP Alpha：已完成

Alpha 目标是验证平台模式单节点闭环：

- 用户登录平台并创建会话。
- 平台按会话绑定在线渗透测试 Node 并下发任务。
- Node 执行 target/scope/DNS/TCP intake。
- Node 使用 DockerSandbox 执行工具。
- 工具输出、资产、漏洞、证据、状态消息实时回传并入库。
- 高风险操作通过平台确认卡片授权。
- 刷新页面或切换会话后，消息、进度、TODO、待处理、资产、漏洞和证据可从后端快照恢复。

### MVP Demo：当前目标

Demo 目标是客户可演示版本，必须同时覆盖 Agent 自治能力、在线平台模式和离线独立模式：

- 渗透 Agent 能建立攻击面清单，识别 URL、参数、表单、服务、端口和技术线索。
- 渗透 Agent 能维护测试覆盖矩阵，避免重复测试同一 `(endpoint, parameter, vuln_type)`。
- 渗透 Agent 只能把有复现请求、响应证据、影响说明和 evidence_ids 的结果确认为漏洞。
- 平台模式可以完成 DVWA/Juice Shop 的端到端演示；该 runbook 是 benchmark harness，不是自治能力的替代品。
- 漏洞、资产、证据可在会话、右侧面板、资产管理页和漏洞管理页查看详情。
- 可基于会话快照导出 Markdown/HTML 报告。
- 证据详情能展示工具输出、HTTP 请求/响应摘要、hash、raw_ref 和来源工具。
- Node 可脱离平台独立完成渗透测试任务。
- Standalone 使用 SQLite 作为本地事实源，证据文件保存在 session workspace。
- Standalone 支持 CLI 创建任务、`--resume <session_id>` 恢复未完成任务。
- Standalone TUI 提供最小观察界面和授权确认，行为与平台确认卡一致。
- 完成后可导出 `report.tar.gz`，平台可导入并恢复会话、消息、资产、漏洞、证据、attack surface 和 coverage 摘要。

## 非 MVP 范围

当前 Demo 不承诺：

- 多节点调度策略、负载均衡、节点队列化。
- 节点后台 daemon、多客户端 attach、并发 session 队列。
- 完整 RBAC、组织、多租户隔离。
- 完整报告中心、模板审批流和长期报告归档。
- 代码审计、应急响应、日志分析、CTF 等其他专业 Node。
- 知识库/记忆增强、子代理、并行工具执行。
- RabbitMQ、生产级 ACK、离线消息补传和多实例 WebSocket 广播。

## 成功标准

MVP Demo 达标必须满足：

- 自治能力：Agent 能在授权范围内发现攻击面，记录测试覆盖，说明下一步选择，并用证据门禁确认或否定漏洞。
- 平台模式：用户可从 Web 会话发起 DVWA/Juice Shop 测试，看到 Agent 执行过程、授权请求、资产、漏洞、证据、coverage 摘要和总结，并在刷新后状态不丢失。
- 独立模式：用户不启动平台，也能用 CLI + TUI 完成一次授权范围内的渗透测试，结果进入 SQLite 和证据目录。
- 同步闭环：Standalone 结果可导出为 `report.tar.gz`，平台导入后能在会话、资产管理、漏洞管理和证据详情中查看。
- 可交付：用户能导出一份包含范围、资产、漏洞、证据摘要、coverage 摘要、时间线和免责声明的 MVP 报告。
- 可排查：会话 ID、任务状态、关键错误、工具失败、coverage、授权记录和证据链可追溯。
- 反注水：Demo readiness 和 autonomy smoke 必须输出攻击面数量、coverage 数量、确认漏洞数量、重复动作、false positive 和人工干预次数，避免用固定脚本冒充自治能力。

## 技术方向

平台前端使用 React、Tailwind、Zustand、TanStack Query 和 WebSocket。平台后端使用 FastAPI、SQLAlchemy、PostgreSQL 和 WebSocket。Node 使用 Python、OpenAI SDK 兼容接口、DockerSandbox、SQLite、Textual/Rich TUI、本地证据文件目录、Attack Surface Inventory、Coverage Store、Verifier Pipeline 和 Finding Quality Gate。

RabbitMQ、多节点、知识库/记忆、完整 Skill runtime、生产级审计与离线补传保留为 MVP 之后的增强。
