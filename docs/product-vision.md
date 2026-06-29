# Product Vision — AI 安全运营平台

> 来源：`vision.json` V2.0 与 `docs/prd.md`
> 生成时间：2026-06-29
> 当前同步：MVP Alpha 闭环已提交 `3725e44 Implement MVP alpha platform loop`；`scripts/validate-vision.js` 缺失，PLAID 自动校验未运行。

## 产品定位

AI 安全运营平台是一个以自然语言对话为核心入口的安全运营系统。它采用平台 + 节点架构，由平台负责会话、资产、漏洞、证据、节点调度和用户交互，由安全节点负责具体工具执行与专业 Agent 流程。

## 核心问题

安全团队在渗透测试、漏洞验证和报告沉淀中经常面对工具链分散、专家经验依赖强、过程不可观测、证据管理割裂和知识难复用的问题。当前 MVP 聚焦先把单节点渗透测试闭环做实，让用户能从 Web 对话页发起任务、观察执行、干预授权，并看到结构化结果沉淀。

## 目标用户

主要用户是安全工程师和渗透测试工程师，他们需要减少重复操作、降低报告整理成本，并让漏洞结论有证据链支撑。次要用户包括安全运营团队管理者、代码审计工程师和应急响应工程师。

## MVP 范围

MVP 聚焦渗透测试 Node 与平台 Web 闭环：

- 用户登录平台并创建会话。
- 用户用自然语言输入目标和测试需求。
- 平台按会话绑定在线渗透测试 Node 并下发任务。
- Node 在进入 LLM loop 前执行确定性 target/scope/DNS/TCP intake，localhost 靶场误用会给出 `host.docker.internal` 提示。
- Node 使用受控 DockerSandbox 执行工具。
- 工具输出、资产、漏洞、证据实时回传并入库。
- 高风险操作通过确认卡片等待用户授权。
- 刷新页面后，会话消息、进度、TODO、待处理授权、发现和证据可从后端快照恢复。

## 非 MVP 范围

CTF、应急响应、日志分析、威胁情报、完整多租户 RBAC、复杂多 Agent 编排、完整报告中心、生产级离线消息补传和完整证据文件同步不纳入当前平台前后端 MVP 闭环。

## 成功标准

MVP Alpha 的成功标准是：单用户、单在线节点、单会话可以完成从任务创建到 Node 执行、授权确认、资产/漏洞/证据入库、前端刷新恢复的端到端闭环，并具备自动化 smoke 覆盖。当前该 Alpha 标准已通过 `alpha_smoke.py`、`node_alpha_smoke.py`、`ws_alpha_smoke.py`、`docker_sandbox_smoke.py`、`docker_sandbox_real_smoke.py` 和 `alpha_browser_smoke.py` 验收；确定性 Task Intake 已纳入 `node_alpha_smoke.py` 和 `ws_alpha_smoke.py` 覆盖。

## 技术方向

平台前端使用 React + Zustand + WebSocket；平台后端使用 FastAPI + SQLAlchemy + PostgreSQL 模型 + WebSocket；Node 使用 Python Agent Runtime、OpenAI SDK 兼容接口和 Docker/Kali 沙箱。RabbitMQ、ACK、心跳补传和生产级多节点调度保留为后续增强。