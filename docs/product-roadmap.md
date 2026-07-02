# 产品路线图 — AI 安全运营平台

> 文档角色：PLAID 一等文档，唯一执行计划和 checkbox 来源。产品范围见 `docs/product-vision.md` 与 `docs/prd.md`，技术边界见 `docs/architecture.md`。
> 最近校准：2026-07-02

## 0. 当前结论

MVP Alpha 单节点平台闭环已经完成；MVP Demo 尚未完成。

最新决策：不能把 Agent 自治能力放到 Demo 之后。Standalone、TUI、SQLite 本地事实源、export/import 仍然属于 MVP Demo，但它们必须建立在“渗透 Agent 能自主发现攻击面、避免重复测试、证据化确认漏洞”的基础上。DVWA/Juice Shop runbook 只作为验收基准和演示脚本，不作为 Agent 自治能力本身。

本 roadmap 只保留可执行计划。已删除或降级的历史规格不再作为实现依据。

## 1. 里程碑

| 里程碑 | 状态 | Demo 价值 |
|---|---:|---|
| MVP Alpha：平台模式单节点闭环 | [x] | 已能从平台发起任务、Node 执行、结果入库、刷新恢复。 |
| MVP Demo Phase 1：Agent 自治能力基线 | [x] | Agent 能先看目标、建立攻击面、按覆盖矩阵推进测试，并只确认有证据的漏洞。 |
| MVP Demo Phase 2：平台结果可交付 | [x] | 平台模式可稳定演示，漏洞/资产/证据/报告可查看、可导出、可排查。 |
| MVP Demo Phase 3：Node Standalone 闭环 | [x] | 无平台环境也能独立测试，SQLite 持久化，CLI/TUI 观察和授权。 |
| MVP Demo Phase 4：Export / Import 闭环 | [x] | Standalone 结果导入平台，进入统一会话、资产、漏洞、证据管理。 |
| MVP Demo Phase 5：演示稳定性与观测 | [ ] | Demo 前可自动检查环境、节点、靶场和关键链路，问题可追踪。 |
| MVP Demo Phase 6：Agent 自主渗透能力增强 | [ ] | 通过 Plan Tree、HTTP 捕获/重放/改包和 Benchmark 提升漏洞覆盖率与可靠性。 |
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

- [x] **TASK-008** — 建立 Attack Surface Inventory。
  Files: `node/pentest_node/agent/attack_surface.py`, `node/pentest_node/tools/http.py`, `node/pentest_node/tools/browser.py`, `tests/`
  Notes: 抽取 host、URL、method、form、参数、链接、登录状态线索、技术栈和端口服务；每条记录带来源 evidence/tool_run_id。
- [x] **TASK-009** — 建立 Coverage Store。
  Files: `node/pentest_node/agent/coverage.py`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 参考 PentesterFlow，记录 `(endpoint, parameter, vuln_type)` 的 tried/passed/failed/skipped 状态，驱动 Agent 选择未覆盖项，避免反复测试同一目标。
- [x] **TASK-010** — 重排 Agent phase 和阶段退出条件。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/tools/workflow.py`, `tests/`
  Notes: 阶段改为 intake -> recon -> analysis -> verify -> report -> complete；phase 不是硬编码拒绝一切，而是目标、推荐工具、退出条件和质量门禁。
- [x] **TASK-011** — 实现 Finding Quality Gate。
  Files: `node/pentest_node/tools/workflow.py`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 参考 AIRecon validators 和 PentesterFlow confirm_finding；漏洞确认必须绑定 evidence_ids、真实目标 URL、复现请求、响应证据、影响说明和修复建议。禁止把“疑似/可能/需要进一步确认”直接变成 confirmed finding。
- [x] **TASK-012** — 补最小 Web 漏洞 verifier。
  Files: `node/pentest_node/agent/verifiers/`, `node/pentest_node/tools/http.py`, `tests/`
  Notes: MVP 先覆盖 DVWA/Juice Shop 可演示的 SQLi、XSS、认证/会话、IDOR/访问控制、敏感信息泄露；verifier 产出结构化 evidence。
- [x] **TASK-013** — 跑 DVWA/Juice Shop 自治验收并记录覆盖率。
  Files: `scripts/agent_autonomy_smoke.py`, `docs/product-roadmap.md`
  Notes: runbook 是 benchmark harness：记录攻击面数量、coverage 数量、confirmed finding 数量、false positive、重复动作和人工干预次数。Verification 2026-07-01: DVWA live-web smoke passed for http://host.docker.internal:8080/login.php; attack_surface=4, coverage=1 passed, evidence=1, duplicate_actions=0, checkpoint=node/workspace/phase1-dvwa-autonomy-checkpoint.json. Juice Shop live-web smoke passed for http://host.docker.internal:3000; attack_surface=3, coverage=1 passed, evidence=1, duplicate_actions=0, checkpoint=node/workspace/phase1-juice-shop-autonomy-checkpoint.json.

## 4. MVP Demo Phase 2：平台结果可交付

目标：平台模式可稳定展示 Agent 的真实工作成果，并交付可查看、可排查、可导出的结果。

- [x] **TASK-014** — 收敛失败去重和错误持久化。
  Files: `node/pentest_node/agent/loop.py`, `platform/backend/app/ws/router.py`, `tests/`
  Notes: phase/tool 错误不能刷屏；失败事件要入库，切换会话后仍可见且不重复。
- [x] **TASK-015** — 补 Evidence 详情弹窗。
  Files: `platform/frontend/src/components/`, `platform/backend/app/api/evidence.py`
  Notes: 从漏洞详情和右侧 Evidence 列表打开，展示 source_tool、tool_run_id、summary、hash、raw_ref、metadata。
- [x] **TASK-016** — 补平台 MVP 报告导出。
  Files: `platform/backend/app/api/`, `platform/frontend/src/pages/`
  Notes: 基于 conversation snapshot 导出 Markdown/HTML，包含目标、scope、资产、漏洞、证据摘要、时间线和免责声明。
- [x] **TASK-017** — 补资产/漏洞详情的 Demo 必需字段。
  Files: `platform/frontend/src/components/VulnDetailDialog.tsx`, `platform/frontend/src/components/AssetDetailDialog.tsx`, `platform/backend/app/api/assets.py`, `platform/backend/app/api/vulnerabilities.py`
  Notes: 漏洞补复现步骤、影响、修复建议、状态时间线；资产补来源会话、最近扫描时间、端口/服务历史。 Verification 2026-07-01: Phase 2 platform deliverables passed `python -m compileall platform\backend\app`, `npm run build`, `python -m unittest tests.test_platform_phase2 tests.test_checkpoint_resume tests.test_web_verifiers tests.test_agent_autonomy_smoke`, and `python scripts\node_alpha_smoke.py`.

## 5. MVP Demo Phase 3：Node Standalone 闭环

目标：不启动平台也能完成授权范围内的渗透测试任务，并通过 CLI/TUI 观察和授权。

- [x] **TASK-018** — 设计并实现 Node SQLite 本地事实源。
  Files: `node/pentest_node/db.py`, `node/pentest_node/models.py`
  Notes: 表包含 sessions、messages、tool_runs、assets、findings、evidence、approvals、checkpoints、attack_surface、coverage；standalone 事件投影已覆盖消息、工具、资产、漏洞、证据、授权、checkpoint、attack surface、coverage。
- [x] **TASK-019** — 抽象统一 Agent event sink。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/platform/`, `node/pentest_node/standalone/`
  Notes: `LocalFirstEventSink` 是 shared Agent event sink contract；standalone 和平台模式均先写 Node SQLite 本地事实源，再分发到 TUI callback、approval handler 或平台 WebSocket。
- [x] **TASK-020** — 实现 standalone CLI 创建任务。
  Files: `node/pentest_node/main.py`
  Notes: 支持 `pentest-node standalone --target <target> --scope <allow> --output <dir>`，不依赖平台 WebSocket。
- [x] **TASK-021** — Standalone 复用平台模式安全门禁。
  Files: `node/pentest_node/agent/intake.py`, `node/pentest_node/tools/execute.py`, `node/pentest_node/tools/http.py`, `node/pentest_node/tools/browser.py`, `node/pentest_node/tools/workflow.py`
  Notes: intake、scope gate、risk gate、Evidence Gate 行为必须和平台模式一致。
- [x] **TASK-022** — 实现 CLI 授权 prompt。
  Files: `node/pentest_node/agent/loop.py`, `node/pentest_node/standalone/`
  Notes: 无 TUI 时，高风险操作在终端显示 proposed_action、risk_level、target，并等待 authorize/cancel。
- [x] **TASK-023** — 实现 `--resume <session_id>`。
  Files: `node/pentest_node/main.py`, `node/pentest_node/db.py`, `node/pentest_node/agent/loop.py`
  Notes: 从 SQLite 最近 checkpoint 恢复未完成任务；不承诺 daemon、attach 或并发队列。
- [x] **TASK-024** — 实现最小 Textual/Rich TUI。
  Files: `node/pentest_node/tui/app.py`, `node/pentest_node/tui/`
  Notes: 参考 `research/AIRecon` 的 Textual 工作台形态：左侧 session/status/tools，中间 transcript 和输入框，右侧 Findings/Assets/Evidence 同屏结果面板；支持空 TUI 启动后输入自然语言任务创建 standalone session，并支持 `/resume <session_id>`。
- [x] **TASK-025** — TUI 授权确认。
  Files: `node/pentest_node/tui/app.py`, `node/pentest_node/agent/loop.py`
  Notes: TUI modal 行为与平台确认卡一致，返回 authorize/cancel；任务运行中输入会作为 steering 注入当前 Agent loop。Verification 2026-07-01: `python -m unittest tests.test_standalone_phase3`, `python -m unittest discover -s tests`, `python -m pentest_node.main standalone --help`, `python -m pentest_node.main --help`, and `python -c "from pentest_node.tui.app import PentestTUI"` passed。

## 6. MVP Demo Phase 4：Export / Import 闭环

目标：Standalone 结果可以导出并导入平台，形成统一资产、漏洞、证据管理。

- [x] **TASK-026** — 定义并实现 `report.tar.gz` 包格式。
  Files: `node/pentest_node/export.py`
  Notes: 包含 manifest.json、conversation.jsonl、assets.json、vulnerabilities.json、evidence.json、attack_surface.json、coverage.json、checkpoints/、evidence/。
- [x] **TASK-027** — 实现 `pentest-node export` CLI。
  Files: `node/pentest_node/main.py`, `node/pentest_node/export.py`
  Notes: 从 SQLite + evidence 文件目录生成自包含导出包；TUI 支持 `/export [path]` 直接导出当前 session。
- [x] **TASK-028** — 重做平台 `/api/sync/import`。
  Files: `platform/backend/app/api/sync.py`, `platform/backend/app/models/`
  Notes: 解析统一包格式，创建 Conversation，导入 Message、Asset、Vulnerability、Evidence、attack surface 和 coverage 摘要。
- [x] **TASK-029** — 导入后前端可查看完整结果。
  Files: `platform/frontend/src/pages/ConversationPage.tsx`, `platform/frontend/src/pages/AssetPage.tsx`, `platform/frontend/src/pages/VulnerabilityPage.tsx`
  Notes: 导入会话可打开，右侧面板、资产页、漏洞页和证据详情可用。
- [x] **TASK-030** — Standalone 到平台导入 smoke。
  Files: `scripts/standalone_import_smoke.py`, `tests/`
  Notes: 自动验证 standalone SQLite 数据、导出包、平台导入、资产/漏洞/证据/coverage 数量一致。 Verification 2026-07-02: Phase 4 export/import passed `python -m unittest tests.test_standalone_phase4 tests.test_standalone_phase3 tests.test_platform_phase2`, `python scripts\standalone_import_smoke.py`, `python -m pentest_node.main export --help`, and `python -m compileall platform\backend\app node\pentest_node`.

## 7. MVP Demo Phase 5：演示稳定性与观测

- [ ] **TASK-031** — 一键 Demo readiness 检查。
  Files: `scripts/demo_readiness.py`
  Notes: 聚合平台 API、WebSocket、Node、DockerSandbox、DVWA/Juice Shop、standalone export/import。
- [x] **TASK-032** — 审计日志 UI 最小版。
  Files: `platform/frontend/src/pages/AuditPage.tsx`, `platform/frontend/src/App.tsx`, `platform/frontend/src/components/Sidebar.tsx`, `platform/backend/app/api/audit.py`
  Notes: 新增审计日志页面，支持按会话和 action 过滤关键事件，展示 actor、status、conversation 和 detail，便于演示和排查。
- [x] **TASK-033** — 节点健康和当前任务展示。
  Files: `platform/frontend/src/pages/NodePage.tsx`, `platform/backend/app/api/nodes.py`, `platform/backend/app/ws/router.py`
  Notes: 节点 API 返回 last_heartbeat、current_task、last_failure_reason；节点页卡片和详情弹窗展示在线状态、当前任务、最近心跳、最近失败原因。
- [ ] **TASK-034** — Demo 观测报告。
  Files: `scripts/agent_autonomy_smoke.py`, `scripts/demo_readiness.py`
  Notes: 输出攻击面覆盖、测试覆盖、确认漏洞、失败工具、重复动作、人工授权次数，避免用固定脚本冒充自治能力。

  Verification 2026-07-02: `python -m py_compile platform\backend\app\api\nodes.py platform\backend\app\ws\router.py platform\backend\app\api\audit.py` and `npm run build` in `platform/frontend` passed.

## 8. MVP Demo Phase 6：Agent 自主渗透能力增强

目标：平台和 TUI 只作为不同 UI/transport，Agent runtime 使用同一套自主测试方式。以少而精工具、强编排、强上下文和可恢复 Plan Tree 提升 DVWA/Juice Shop benchmark 覆盖率。评分细则见 `docs/agent-autonomy-benchmark.md`。

参考来源：`research/anything-analyzer` 的抓包会话和请求详情、`research/AIRecon` 的 proxy history/replay/fuzz marker/coverage、`research/PentesterFlow-agent` 的 webvuln skill、`research/pentestagent` 的 playbook/crew runtime。

- [x] **TASK-035** — 定义 Agent Autonomy Benchmark 和离线评分器。
  Files: `docs/agent-autonomy-benchmark.md`, `scripts/agent_benchmark.py`, `tests/`
  Notes: Benchmark 是开发侧考官，不进入产品 UI，不向 Agent 注入答案；Markdown 是第一版答案，离线脚本只抽取 session 事实材料，输出 `benchmark-report.json` / `benchmark-report.md`。
  Verification 2026-07-02: `python -m unittest tests.test_agent_benchmark` and `python -m py_compile scripts\agent_benchmark.py tests\test_agent_benchmark.py` passed.
- [ ] **TASK-036** — 实现 Exploration Plan Tree。
  Files: `node/pentest_node/agent/plan_tree.py`, `node/pentest_node/tools/workflow.py`, `platform/backend/app/services/conversation_snapshot.py`, `tests/`
  Notes: Plan Tree 是 Agent 的工作笔记本；运行时从 attack surface/traffic 自动生成基础节点，Agent 通过 `plan_add_node`、`plan_update_node`、`plan_next`、`plan_prune_or_complete` 维护计划。
- [ ] **TASK-037** — 实现 mitmproxy Traffic Capture sidecar。
  Files: `node/pentest_node/traffic/`, `node/pentest_node/tools/`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 平台模式和 standalone/TUI 共用同一 Agent runtime；第一版工具为 `capture_start`、`capture_list_requests`、`capture_get_request`、`capture_replay_request`、`capture_mutate_request`。
- [ ] **TASK-038** — 将捕获流量转为 attack surface、Plan Tree 和 coverage gaps。
  Files: `node/pentest_node/agent/attack_surface.py`, `node/pentest_node/agent/coverage.py`, `node/pentest_node/agent/plan_tree.py`, `tests/`
  Notes: 捕获到的真实请求生成 endpoint/form/parameter 节点，驱动 Agent 从真实请求重放和改包，避免凭空猜 URL。
- [ ] **TASK-039** — 接入少而精的 Web Skill Playbooks。
  Files: `node/pentest_node/skills/`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 先覆盖 SQLi、XSS、Auth/Session、IDOR/Access Control、Info Disclosure；参考 PentesterFlow，强调 real PoC、http/curl 优先、非必要不默认堆扫描器。
- [ ] **TASK-040** — Context Pack 管理。
  Files: `node/pentest_node/agent/context_pack.py`, `node/pentest_node/agent/loop.py`, `tests/`
  Notes: 每轮只注入当前路径、top pending/blocked plan nodes、coverage gaps、最近证据和关键请求，降低上下文噪声。
- [ ] **TASK-041** — Plan Tree 在平台和 TUI 可视化。
  Files: `platform/frontend/src/components/RightPanel.tsx`, `node/pentest_node/tui/app.py`, `platform/backend/app/services/conversation_snapshot.py`, `tests/`
  Notes: 平台展示可展开树形 TODO；TUI 展示压缩版当前路径和 top pending/blocked；两者都读取 checkpoint/event 数据。
- [ ] **TASK-042** — DVWA/Juice Shop benchmark smoke 达到 80%。
  Files: `scripts/agent_benchmark.py`, `scripts/agent_autonomy_smoke.py`, `tests/`
  Notes: 按 `docs/agent-autonomy-benchmark.md` 的 P0+P1 case list 评分；Benchmark 只做事后判定，不提示 Agent。

## 9. Post-MVP

这些能力有价值，但不阻塞当前 Demo：

- 多节点调度、负载策略、节点任务队列。
- RabbitMQ、ACK、生产级心跳和离线补传。
- 完整 RBAC、组织、多租户。
- 后台 daemon、多客户端 attach、并发 standalone session 队列。
- 完整报告中心、模板、审批流。
- 完整 Skill runtime、知识库/记忆注入、子代理、并行工具执行。
- 代码审计、应急响应、日志分析、CTF Node。

## 10. 下一步

下一步保持 Phase 5 的 TASK-031/TASK-034 未完成项可并行推进；Agent 能力主线进入 **MVP Demo Phase 6：Agent 自主渗透能力增强**，从 **TASK-035 到 TASK-042** 开始。Phase 6 的核心是 Benchmark 先行、Exploration Plan Tree、mitmproxy Traffic Capture / Replay / Mutate、Skill Playbooks、Context Pack，以及 DVWA/Juice Shop 80% benchmark smoke。
