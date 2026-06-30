# 产品路线图 — AI 安全运营平台

> 文档角色：PLAID 一等文档，唯一执行计划和 checkbox 来源。产品范围见 `docs/product-vision.md` 与 `docs/prd.md`，技术边界见 `docs/architecture.md`。
> 最近校准：2026-07-01

## 0. 当前结论

MVP Alpha 单节点平台闭环已经完成；MVP Demo 尚未完成。

最新决策：不能把 Agent 自治能力放到 Demo 之后。Standalone、TUI、SQLite 本地事实源、export/import 仍然属于 MVP Demo，但它们必须建立在“渗透 Agent 能自主发现攻击面、避免重复测试、证据化确认漏洞”的基础上。DVWA/Juice Shop runbook 只作为验收基准和演示脚本，不作为 Agent 自治能力本身。

本 roadmap 只保留可执行计划。已删除或降级的历史规格不再作为实现依据。

## 1. 里程碑

| 里程碑 | 状态 | Demo 价值 |
|---|---:|---|
| MVP Alpha：平台模式单节点闭环 | [x] | 已能从平台发起任务、Node 执行、结果入库、刷新恢复。 |
| MVP Demo Phase 1：Agent 自治能力基线 | [ ] | Agent 能先看目标、建立攻击面、按覆盖矩阵推进测试，并只确认有证据的漏洞。 |
| MVP Demo Phase 2：平台结果可交付 | [ ] | 平台模式可稳定演示，漏洞/资产/证据/报告可查看、可导出、可排查。 |
| MVP Demo Phase 3：Node Standalone 闭环 | [ ] | 无平台环境也能独立测试，SQLite 持久化，CLI/TUI 观察和授权。 |
| MVP Demo Phase 4：Export / Import 闭环 | [ ] | Standalone 结果导入平台，进入统一会话、资产、漏洞、证据管理。 |
| MVP Demo Phase 5：演示稳定性与观测 | [ ] | Demo 前可自动检查环境、节点、靶场和关键链路，问题可追踪。 |
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

## 3. MVP Demo Phase 1：Agent 自治能力基线

目标：参考 AIRecon 和 PentesterFlow 的成熟做法，先让渗透 Agent 具备最小自治测试能力，而不是只包装一个会跑脚本的 UI。专项设计见 `docs/phase1-agent-autonomy-baseline.md`。

- [ ] **TASK-008** — 建立 Attack Surface Inventory。
  Files: `node/pentest_node/agent/attack_surface.py`, `node/pentest_node/tools/http.py`, `node/pentest_node/tools/browser.py`, `tests/`
  Notes: 抽取 host、URL、method、form、参数、链接、登录状态线索、技术栈和端口服务；每条记录带来源 evidence/tool_run_id。
- [ ] **TASK-009** — 建立 Coverage Store。
  Files: `node/pentest_node/agent/coverage.py`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 参考 PentesterFlow，记录 `(endpoint, parameter, vuln_type)` 的 tried/passed/failed/skipped 状态，驱动 Agent 选择未覆盖项，避免反复测试同一目标。
- [ ] **TASK-010** — 重排 Agent phase 和阶段退出条件。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/tools/workflow.py`, `tests/`
  Notes: 阶段改为 intake -> recon -> analysis -> verify -> report -> complete；phase 不是硬编码拒绝一切，而是目标、推荐工具、退出条件和质量门禁。
- [ ] **TASK-011** — 实现 Finding Quality Gate。
  Files: `node/pentest_node/tools/workflow.py`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 参考 AIRecon validators 和 PentesterFlow confirm_finding；漏洞确认必须绑定 evidence_ids、真实目标 URL、复现请求、响应证据、影响说明和修复建议。禁止把“疑似/可能/需要进一步确认”直接变成 confirmed finding。
- [ ] **TASK-012** — 补最小 Web 漏洞 verifier。
  Files: `node/pentest_node/agent/verifiers/`, `node/pentest_node/tools/http.py`, `tests/`
  Notes: MVP 先覆盖 DVWA/Juice Shop 可演示的 SQLi、XSS、认证/会话、IDOR/访问控制、敏感信息泄露；verifier 产出结构化 evidence。
- [ ] **TASK-013** — 跑 DVWA/Juice Shop 自治验收并记录覆盖率。
  Files: `scripts/agent_autonomy_smoke.py`, `docs/product-roadmap.md`
  Notes: runbook 是 benchmark harness：记录攻击面数量、coverage 数量、confirmed finding 数量、false positive、重复动作和人工干预次数。

## 4. MVP Demo Phase 2：平台结果可交付

目标：平台模式可稳定展示 Agent 的真实工作成果，并交付可查看、可排查、可导出的结果。

- [ ] **TASK-014** — 收敛失败去重和错误持久化。
  Files: `node/pentest_node/agent/loop.py`, `platform/backend/app/ws/router.py`, `tests/`
  Notes: phase/tool 错误不能刷屏；失败事件要入库，切换会话后仍可见且不重复。
- [ ] **TASK-015** — 补 Evidence 详情弹窗。
  Files: `platform/frontend/src/components/`, `platform/backend/app/api/evidence.py`
  Notes: 从漏洞详情和右侧 Evidence 列表打开，展示 source_tool、tool_run_id、summary、hash、raw_ref、metadata。
- [ ] **TASK-016** — 补平台 MVP 报告导出。
  Files: `platform/backend/app/api/`, `platform/frontend/src/pages/`
  Notes: 基于 conversation snapshot 导出 Markdown/HTML，包含目标、scope、资产、漏洞、证据摘要、时间线和免责声明。
- [ ] **TASK-017** — 补资产/漏洞详情的 Demo 必需字段。
  Files: `platform/frontend/src/components/VulnDetailDialog.tsx`, `platform/frontend/src/components/AssetDetailDialog.tsx`, `platform/backend/app/api/assets.py`, `platform/backend/app/api/vulnerabilities.py`
  Notes: 漏洞补复现步骤、影响、修复建议、状态时间线；资产补来源会话、最近扫描时间、端口/服务历史。

## 5. MVP Demo Phase 3：Node Standalone 闭环

目标：不启动平台也能完成授权范围内的渗透测试任务，并通过 CLI/TUI 观察和授权。

- [ ] **TASK-018** — 设计并实现 Node SQLite 本地事实源。
  Files: `node/pentest_node/db.py`, `node/pentest_node/models.py`
  Notes: 表包含 sessions、messages、tool_runs、assets、findings、evidence、approvals、checkpoints、attack_surface、coverage。
- [ ] **TASK-019** — 抽象统一 Agent event sink。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/platform/`, `node/pentest_node/standalone/`
  Notes: Agent 事件先写本地事实源，再分发到平台 WebSocket、TUI 或 export；避免平台模式和 standalone 双实现。
- [ ] **TASK-020** — 实现 standalone CLI 创建任务。
  Files: `node/pentest_node/main.py`
  Notes: 支持 `pentest-node standalone --target <target> --scope <allow> --output <dir>`，不依赖平台 WebSocket。
- [ ] **TASK-021** — Standalone 复用平台模式安全门禁。
  Files: `node/pentest_node/agent/intake.py`, `node/pentest_node/tools/execute.py`, `node/pentest_node/tools/http.py`, `node/pentest_node/tools/browser.py`, `node/pentest_node/tools/workflow.py`
  Notes: intake、scope gate、risk gate、Evidence Gate 行为必须和平台模式一致。
- [ ] **TASK-022** — 实现 CLI 授权 prompt。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/standalone/`
  Notes: 无 TUI 时，高风险操作在终端显示 proposed_action、risk_level、target，并等待 authorize/cancel。
- [ ] **TASK-023** — 实现 `--resume <session_id>`。
  Files: `node/pentest_node/main.py`, `node/pentest_node/db.py`, `node/pentest_node/agent/loop.py`
  Notes: 从 SQLite 最近 checkpoint 恢复未完成任务；不承诺 daemon、attach 或并发队列。
- [ ] **TASK-024** — 实现最小 Textual/Rich TUI。
  Files: `node/pentest_node/tui/app.py`, `node/pentest_node/tui/`
  Notes: 参考 `research/AIRecon` 的 Textual 形态，显示 phase、iteration、active tool、Agent 输出、工具调用、Findings、Assets、Evidence、Coverage。
- [ ] **TASK-025** — TUI 授权确认。
  Files: `node/pentest_node/tui/app.py`, `node/pentest_node/agent/loop.py`
  Notes: TUI modal 行为与平台确认卡一致，返回 authorize/cancel。

## 6. MVP Demo Phase 4：Export / Import 闭环

目标：Standalone 结果可以导出并导入平台，形成统一资产、漏洞、证据管理。

- [ ] **TASK-026** — 定义并实现 `report.tar.gz` 包格式。
  Files: `node/pentest_node/export.py`
  Notes: 包含 manifest.json、conversation.jsonl、assets.json、vulnerabilities.json、evidence.json、attack_surface.json、coverage.json、checkpoints/、evidence/。
- [ ] **TASK-027** — 实现 `pentest-node export` CLI。
  Files: `node/pentest_node/main.py`, `node/pentest_node/export.py`
  Notes: 从 SQLite + evidence 文件目录生成自包含导出包。
- [ ] **TASK-028** — 重做平台 `/api/sync/import`。
  Files: `platform/backend/app/api/sync.py`, `platform/backend/app/models/`
  Notes: 解析统一包格式，创建 Conversation，导入 Message、Asset、Vulnerability、Evidence、attack surface 和 coverage 摘要。
- [ ] **TASK-029** — 导入后前端可查看完整结果。
  Files: `platform/frontend/src/pages/ConversationPage.tsx`, `platform/frontend/src/pages/AssetPage.tsx`, `platform/frontend/src/pages/VulnerabilityPage.tsx`
  Notes: 导入会话可打开，右侧面板、资产页、漏洞页和证据详情可用。
- [ ] **TASK-030** — Standalone 到平台导入 smoke。
  Files: `scripts/standalone_import_smoke.py`, `tests/`
  Notes: 自动验证 standalone SQLite 数据、导出包、平台导入、资产/漏洞/证据/coverage 数量一致。

## 7. MVP Demo Phase 5：演示稳定性与观测

- [ ] **TASK-031** — 一键 Demo readiness 检查。
  Files: `scripts/demo_readiness.py`
  Notes: 聚合平台 API、WebSocket、Node、DockerSandbox、DVWA/Juice Shop、standalone export/import。
- [ ] **TASK-032** — 审计日志 UI 最小版。
  Files: `platform/frontend/src/pages/`, `platform/backend/app/api/audit.py`
  Notes: 至少能按会话查看关键事件，便于演示和排查。
- [ ] **TASK-033** — 节点健康和当前任务展示。
  Files: `platform/frontend/src/pages/NodePage.tsx`, `platform/backend/app/api/nodes.py`, `platform/backend/app/ws/router.py`
  Notes: 展示在线状态、当前任务、最近心跳、最近失败原因。
- [ ] **TASK-034** — Demo 观测报告。
  Files: `scripts/agent_autonomy_smoke.py`, `scripts/demo_readiness.py`
  Notes: 输出攻击面覆盖、测试覆盖、确认漏洞、失败工具、重复动作、人工授权次数，避免用固定脚本冒充自治能力。

## 8. Post-MVP

这些能力有价值，但不阻塞当前 Demo：

- 多节点调度、负载策略、节点任务队列。
- RabbitMQ、ACK、生产级心跳和离线补传。
- 完整 RBAC、组织、多租户。
- 后台 daemon、多客户端 attach、并发 standalone session 队列。
- 完整报告中心、模板、审批流。
- 完整 Skill runtime、知识库/记忆注入、子代理、并行工具执行。
- 代码审计、应急响应、日志分析、CTF Node。

## 9. 下一步

下一步从 **TASK-008 到 TASK-013** 做 Agent 自治能力基线。理由是：如果 Agent 不能建立攻击面、按覆盖矩阵推进、用证据门禁确认漏洞，那么后续 Standalone、TUI、export/import 只是在包装一个不稳定的测试循环，无法支撑客户 Demo。
