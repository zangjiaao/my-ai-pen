# 产品路线图 — AI 安全运营平台

> 文档角色：PLAID 一等文档，唯一执行计划和 checkbox 来源。产品范围见 `docs/product-vision.md` 与 `docs/prd.md`，技术边界见 `docs/architecture.md`。
> 最近校准：2026-07-01

## 0. 当前结论

MVP Alpha 单节点平台闭环已经完成；MVP Demo 尚未完成。

最新决策：客户 Demo 必须包含 Node standalone 独立闭环。Standalone、TUI、SQLite 本地事实源、export/import 不再是 Post-MVP，而是 MVP Demo 的必要阶段。

本 roadmap 只保留可执行计划。已删除或降级的历史规格不再作为实现依据。

## 1. 里程碑

| 里程碑 | 状态 | Demo 价值 |
|---|---:|---|
| MVP Alpha：平台模式单节点闭环 | [x] | 已能从平台发起任务、Node 执行、结果入库、刷新恢复。 |
| MVP Demo Phase 1：平台演示可交付 | [ ] | 平台模式可稳定演示，漏洞/资产/证据/报告可交付。 |
| MVP Demo Phase 2：Node Standalone 闭环 | [ ] | 无平台环境也能独立测试、TUI 观察、SQLite 持久化、导出结果。 |
| MVP Demo Phase 3：离线结果导入平台 | [ ] | Standalone 结果导入平台，进入统一会话、资产、漏洞、证据管理。 |
| MVP Production | [ ] | 生产部署、ACK/心跳、权限隔离、多节点可靠性。 |

## 2. 已完成基线

- [x] **TASK-001** — 平台登录、会话、新建/删除/重命名、会话 ID 展示。
  Files: `platform/frontend/src/pages/ConversationPage.tsx`, `platform/backend/app/api/conversations.py`
  Notes: 会话过程已入库，删除会清理关联消息/资产/漏洞/证据。

- [x] **TASK-002** — 平台 WebSocket 用户连接、节点连接、任务下发和消息持久化。
  Files: `platform/backend/app/ws/router.py`
  Notes: 当前核心通信仍是 WebSocket 内存连接表，不是 RabbitMQ。

- [x] **TASK-003** — Node 平台模式 Agent loop、intake、scope gate、DockerSandbox、工具调用。
  Files: `node/pentest_node/main.py`, `node/pentest_node/agent/loop.py`, `node/pentest_node/agent/intake.py`
  Notes: 单任务执行，当前没有 SessionQueue。

- [x] **TASK-004** — 资产、漏洞、证据入库和详情查看。
  Files: `platform/backend/app/api/assets.py`, `platform/backend/app/api/vulnerabilities.py`, `platform/backend/app/api/evidence.py`, `platform/frontend/src/components/VulnDetailDialog.tsx`, `platform/frontend/src/components/AssetDetailDialog.tsx`
  Notes: 资产/漏洞/证据已是平台库的一等数据。

- [x] **TASK-005** — 会话刷新恢复、TanStack 消息加载、右侧面板恢复。
  Files: `platform/backend/app/services/conversation_snapshot.py`, `platform/frontend/src/pages/ConversationPage.tsx`
  Notes: 后端 snapshot 是恢复视图事实源。

- [x] **TASK-006** — Markdown/table 渲染、工具卡片合并、working 状态、Agent 来源显示。
  Files: `platform/frontend/src/components/MessageRenderer.tsx`, `platform/frontend/src/pages/ConversationPage.tsx`
  Notes: UI 状态统一为 running/done/fail。

- [x] **TASK-007** — OpenAI SDK 兼容替代 LiteLLM。
  Files: `node/pentest_node/agent/llm.py`, `platform/backend/app/services/completed_conversation_agent.py`
  Notes: 通过 `base_url` 支持兼容服务。

## 3. MVP Demo Phase 1：平台演示可交付

目标：平台模式可稳定对 DVWA/Juice Shop 演示，并交付可信结果。

- [ ] **TASK-008** — 固化 DVWA/Juice Shop 平台模式演示 runbook。
  Files: `docs/product-roadmap.md`, `scripts/`
  Notes: 包含平台、Node、靶场启动顺序，`localhost` 与 `host.docker.internal` 说明，演示输入语句和预期结果。

- [ ] **TASK-009** — 跑一轮真实 DVWA/Juice Shop 人工验收并记录 Agent 行为问题。
  Files: `docs/product-roadmap.md`, `scripts/`
  Notes: 重点记录重复输出、阶段误用、误报、漏报、错误工具选择、不实际访问目标等问题。

- [ ] **TASK-010** — 收敛 Agent phase 控制和失败去重。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/tools/workflow.py`, `tests/`
  Notes: 错误 phase 调用不允许工具时不能刷屏；失败要进入可恢复路径。

- [ ] **TASK-011** — 补 Evidence 详情弹窗。
  Files: `platform/frontend/src/components/`, `platform/backend/app/api/evidence.py`
  Notes: 从漏洞详情和右侧 Evidence 列表打开，展示 source_tool、tool_run_id、summary、hash、raw_ref、metadata。

- [ ] **TASK-012** — 补平台 MVP 报告导出。
  Files: `platform/backend/app/api/`, `platform/frontend/src/pages/`
  Notes: 基于 conversation snapshot 导出 Markdown/HTML，包含目标、scope、资产、漏洞、证据摘要、时间线、免责声明。

- [ ] **TASK-013** — 补资产/漏洞详情的 Demo 必需字段。
  Files: `platform/frontend/src/components/VulnDetailDialog.tsx`, `platform/frontend/src/components/AssetDetailDialog.tsx`, `platform/backend/app/api/assets.py`, `platform/backend/app/api/vulnerabilities.py`
  Notes: 漏洞补复现步骤、影响、修复建议、状态时间线；资产补来源会话、最近扫描时间、端口/服务历史。

## 4. MVP Demo Phase 2：Node Standalone 闭环

目标：不启动平台也能完成授权范围内的渗透测试任务，并通过 TUI 观察和授权。

- [ ] **TASK-014** — 设计并实现 Node SQLite 本地事实源。
  Files: `node/pentest_node/db.py`, `node/pentest_node/models.py`
  Notes: 表包含 sessions、messages、tool_runs、assets、findings、evidence、approvals、checkpoints。

- [ ] **TASK-015** — 抽象统一 Agent event sink。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/platform/`
  Notes: Agent 事件先写本地事实源，再分发到平台 WebSocket、TUI 或 export；避免平台模式和 standalone 双实现。

- [ ] **TASK-016** — 实现 standalone CLI 创建任务。
  Files: `node/pentest_node/main.py`
  Notes: 支持 `pentest-node standalone --target <target> --scope <allow> --output <dir>`，不依赖平台 WebSocket。

- [ ] **TASK-017** — Standalone 复用平台模式安全门禁。
  Files: `node/pentest_node/agent/intake.py`, `node/pentest_node/tools/execute.py`, `node/pentest_node/tools/http.py`, `node/pentest_node/tools/browser.py`, `node/pentest_node/tools/workflow.py`
  Notes: intake、scope gate、risk gate、Evidence Gate 行为必须和平台模式一致。

- [ ] **TASK-018** — 实现 CLI 授权 prompt。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/standalone/`
  Notes: 无 TUI 时，高风险操作在终端显示 proposed_action、risk_level、target，并等待 authorize/cancel。

- [ ] **TASK-019** — 实现 `--resume <session_id>`。
  Files: `node/pentest_node/main.py`, `node/pentest_node/db.py`, `node/pentest_node/agent/loop.py`
  Notes: 从 SQLite 最近 checkpoint 恢复未完成任务；不承诺 daemon、attach 或并发队列。

- [ ] **TASK-020** — 实现最小 Textual/Rich TUI。
  Files: `node/pentest_node/tui/app.py`, `node/pentest_node/tui/`
  Notes: 参考 `research/AIRecon` 的 Textual 形态，显示 phase、iteration、active tool、Agent 输出、工具调用、Findings、Assets、Evidence。

- [ ] **TASK-021** — TUI 授权确认。
  Files: `node/pentest_node/tui/app.py`, `node/pentest_node/agent/loop.py`
  Notes: TUI modal 行为与平台确认卡一致，返回 authorize/cancel。

## 5. MVP Demo Phase 3：Export / Import 闭环

目标：Standalone 结果可以导出并导入平台，形成统一资产、漏洞、证据管理。

- [ ] **TASK-022** — 定义并实现 `report.tar.gz` 包格式。
  Files: `node/pentest_node/export.py`
  Notes: 包含 manifest.json、conversation.jsonl、assets.json、vulnerabilities.json、evidence.json、checkpoints/、evidence/。

- [ ] **TASK-023** — 实现 `pentest-node export` CLI。
  Files: `node/pentest_node/main.py`, `node/pentest_node/export.py`
  Notes: 从 SQLite + evidence 文件目录生成自包含导出包。

- [ ] **TASK-024** — 重做平台 `/api/sync/import`。
  Files: `platform/backend/app/api/sync.py`, `platform/backend/app/models/`
  Notes: 解析统一包格式，创建 Conversation，导入 Message、Asset、Vulnerability、Evidence。

- [ ] **TASK-025** — 导入后前端可查看完整结果。
  Files: `platform/frontend/src/pages/ConversationPage.tsx`, `platform/frontend/src/pages/AssetPage.tsx`, `platform/frontend/src/pages/VulnerabilityPage.tsx`
  Notes: 导入会话可打开，右侧面板、资产页、漏洞页和证据详情可用。

- [ ] **TASK-026** — Standalone 到平台导入 smoke。
  Files: `scripts/standalone_import_smoke.py`, `tests/`
  Notes: 自动验证 standalone SQLite 数据、导出包、平台导入、资产/漏洞/证据数量一致。

## 6. MVP Demo Phase 4：演示稳定性

- [ ] **TASK-027** — 一键 Demo readiness 检查。
  Files: `scripts/demo_readiness.py`
  Notes: 聚合平台 API、WebSocket、Node、DockerSandbox、DVWA/Juice Shop、standalone export/import。

- [ ] **TASK-028** — 审计日志 UI 最小版。
  Files: `platform/frontend/src/pages/`, `platform/backend/app/api/audit.py`
  Notes: 至少能按会话查看关键事件，便于演示和排查。

- [ ] **TASK-029** — 节点健康和当前任务展示。
  Files: `platform/frontend/src/pages/NodePage.tsx`, `platform/backend/app/api/nodes.py`, `platform/backend/app/ws/router.py`
  Notes: 展示在线状态、当前任务、最近心跳、最近失败原因。

## 7. Post-MVP

这些能力有价值，但不阻塞当前 Demo：

- 多节点调度、负载策略、节点任务队列。
- RabbitMQ、ACK、生产级心跳和离线补传。
- 完整 RBAC、组织、多租户。
- 后台 daemon、多客户端 attach、并发 standalone session 队列。
- 完整报告中心、模板、审批流。
- Skill runtime、知识库/记忆注入、子代理、并行工具执行。
- 代码审计、应急响应、日志分析、CTF Node。

## 8. 下一步

推荐立即从 **TASK-008 到 TASK-013** 完成平台 Demo 可交付面，然后进入 **TASK-014** 开始 Standalone 本地事实源。原因是 Standalone 会复用大量平台模式 Agent 事件和证据模型，先稳定平台演示能减少后续返工。
