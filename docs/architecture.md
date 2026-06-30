# 架构设计文档 — AI 安全运营平台

> 文档角色：PLAID 一等文档，描述当前真实架构、MVP Demo 目标架构和明确的非目标。产品需求见 `docs/prd.md`，执行计划见 `docs/product-roadmap.md`。
> 最近校准：2026-07-01

## 1. 文档边界

`docs/` 只保留五个一等文档：

- `product-vision.md`：产品方向和 MVP 边界。
- `prd.md`：功能需求和验收标准。
- `architecture.md`：技术架构、数据流、协议和模块边界。
- `product-roadmap.md`：唯一执行计划。
- `design.md`：视觉和交互设计系统。

Node Skill 内容属于运行时资料，保留在 `node/skills/`。历史超前规格不再作为实现依据。

## 2. 架构总览

MVP Demo 包含两条运行闭环和一条同步闭环：

1. 平台模式：浏览器 -> 平台后端 -> WebSocket -> Pentest Node -> 平台库。
2. Standalone 模式：CLI/TUI -> Pentest Node -> SQLite + evidence files。
3. 同步模式：Standalone `report.tar.gz` -> 平台导入 -> 统一会话/资产/漏洞/证据管理。

```text
平台模式
Browser / React
  -> FastAPI REST + WebSocket
  -> PostgreSQL
  -> Pentest Node WebSocket client
  -> Agent Loop
  -> Attack Surface Inventory + Coverage Store + Verifiers + Finding Gate
  -> DockerSandbox + Evidence Store
  -> WebSocket events back to Platform

Standalone 模式
CLI / Textual TUI
  -> Pentest Node Agent Loop
  -> Attack Surface Inventory + Coverage Store + Verifiers + Finding Gate
  -> SQLite local source of truth
  -> Evidence workspace files
  -> report.tar.gz export
  -> Platform /api/sync/import
```

## 3. 当前真实实现

### 3.1 平台前端

- React + Tailwind + Zustand + TanStack Query。
- 路由包括会话、资产、漏洞、节点、Skill、知识库、记忆。
- 当前核心可用页是会话、资产、漏洞、节点。
- 会话页使用后端 snapshot 恢复消息、资产、漏洞、证据、进度和待处理。
- 消息渲染支持 text/status/tool/vuln/asset/confirm/pending/thinking。
- Attack chain、scoreboard、summary card 不是当前主链路能力。

### 3.2 平台后端

- FastAPI + SQLAlchemy + PostgreSQL 模型。
- REST API 覆盖 auth、conversations、assets、vulnerabilities、evidence、nodes、audit、sync。
- WebSocket 使用内存 `node_connections` 和 `conversation_subscribers`。
- 消息、资产、漏洞、证据和审计事件会入库。
- `conversation_snapshot` 是刷新和会话恢复的后端事实源。
- RabbitMQ 文件存在，但不是当前核心通信路径。

### 3.3 Pentest Node 平台模式

- `node/pentest_node/main.py` 当前支持平台 WebSocket 模式。
- 当前只执行一个 `current_task`，忙时返回 `Node is busy`。
- `--standalone` 当前尚未实现。
- Agent loop 当前阶段为 precheck、plan、recon、scan、verify、report。
- 工具包括 execute、http_request、browser、workflow tools。
- `load_skill` 工具存在，但未作为 Demo 主链路能力接入。
- Evidence Store 会写本地文件，并通过事件同步 evidence metadata。

## 4. Agent 自治架构

Agent 自治能力是 MVP Demo 的前置基础，不是 Post-MVP。参考 AIRecon 和 PentesterFlow 后，MVP 采用以下最小组件。

### 4.1 Attack Surface Inventory

职责：把目标真实暴露面结构化，避免 Agent 只凭聊天上下文猜测下一步。

最低记录：

- `surface_id`
- `session_id` 或 `conversation_id`
- `kind`：host、url、form、api_endpoint、service、port
- `method`
- `url` 或 `address`
- `parameters`
- `auth_context`
- `technology_hints`
- `source_tool_run_id`
- `evidence_ids`
- `created_at`
- `updated_at`

来源：intake、HTTP 抓取、browser 探索、端口扫描、工具输出解析。

### 4.2 Coverage Store

职责：记录每个攻击面上的测试覆盖，驱动 Agent 选择“未测项”，减少重复测试。

最低记录：

- `coverage_id`
- `session_id` 或 `conversation_id`
- `endpoint`
- `parameter`
- `vuln_type`
- `status`：tried、passed、failed、skipped
- `count`
- `notes`
- `first_seen`
- `last_seen`

Agent 每次 meaningful test 后必须 mark coverage。规划下一步时，Agent prompt 注入 coverage 摘要和未覆盖候选。

### 4.3 Phase Controller

目标阶段：intake -> recon -> analysis -> verify -> report -> complete。

阶段控制原则：

- phase 提供目标、推荐工具、允许工具、退出条件和失败恢复建议。
- phase 不能只靠硬拒绝工具调用，否则会造成重复错误和卡死。
- 错误工具调用应转化为一次可恢复 observation，并提示下一步合法动作。
- 进入 report 前必须存在 confirmed finding 或明确的 no finding 结论和 coverage 摘要。

### 4.4 Verifier Pipeline

Verifier 是确定性或半确定性的漏洞验证模块，负责把候选漏洞转化为证据。

MVP verifier：

- SQLi verifier
- XSS verifier
- Auth/session verifier
- IDOR/access-control verifier
- Sensitive-info verifier

Verifier 输出：

- structured observation
- evidence record
- coverage mark
- candidate finding 或 confirmed finding 所需字段

### 4.5 Finding Quality Gate

confirmed finding 必须满足：

- 真实目标 URL 或资产。
- 明确漏洞类型和影响位置。
- evidence_ids。
- 复现请求或 curl。
- 响应证据或可观察影响。
- 影响说明。
- 修复建议。

疑似发现、scanner 命中、无法复现的行为只能作为 candidate finding 或 observation，不能进入 confirmed 漏洞库。

## 5. 平台数据模型

平台 PostgreSQL 是在线会话和导入结果的统一事实源。

核心表：

- `users`
- `conversations`
- `messages`
- `nodes`
- `assets`
- `vulnerabilities`
- `evidence`
- `audit_log`

MVP Demo 可选新增或以 JSON 摘要落地：

- `attack_surface`
- `coverage`

关键原则：

- 所有平台资源按 `user_id` 过滤。
- Conversation 是用户可见工作单元。
- Message 是会话过程的可恢复记录。
- Asset、Vulnerability、Evidence 是平台管理对象，不应只存在于消息里。
- Conversation context 可以保存 task、scope、checkpoint、coverage summary 等运行态摘要，但不能替代结构化表。

## 6. Node Standalone 目标架构

Standalone 是 MVP Demo 范围内的目标。

### 6.1 本地事实源

Node standalone 必须使用 SQLite 作为本地事实源。最低表结构：

- `sessions`：session_id、target、scope、status、created_at、updated_at、output_dir。
- `messages`：session_id、role、msg_type、content、created_at。
- `tool_runs`：tool_run_id、session_id、tool_name、args、status、stdout_ref、stderr_ref、started_at、ended_at。
- `assets`：session_id、address、asset_type、ports、services、properties。
- `findings`：session_id、title、severity、status、affected_asset、location、evidence_ids、description、remediation。
- `evidence`：evidence_id、session_id、type、source_tool、tool_run_id、summary、hash、raw_ref、metadata。
- `approvals`：request_id、session_id、risk_level、proposed_action、target、status、created_at、resolved_at。
- `checkpoints`：session_id、iteration、phase、snapshot、created_at。
- `attack_surface`：session_id、kind、url/address、method、parameters、source_tool_run_id、evidence_ids、metadata。
- `coverage`：session_id、endpoint、parameter、vuln_type、status、count、notes、first_seen、last_seen。

### 6.2 事件写入原则

Agent loop 不应直接关心平台或 TUI。它应发出统一 Agent event：

- 先写本地事实源。
- 再广播给当前运行适配器：平台 WebSocket、TUI、CLI stdout 或 export。

这样平台模式和 standalone 模式共享 intake、scope gate、risk gate、Evidence Gate、Attack Surface、Coverage、Verifier、Finding Gate 和 checkpoint 逻辑。

### 6.3 授权模型

高风险操作的授权行为必须一致：

- 平台模式：发出 `request_decision`，由平台确认卡返回 `authorize/cancel`。
- Standalone + TUI：Textual modal 返回 `authorize/cancel`。
- Standalone CLI：终端 prompt 返回 `authorize/cancel`。

Agent loop 只接收统一授权结果，不区分来源。

### 6.4 Resume

Demo 版支持 `--resume <session_id>`：

- 从 SQLite 找到 session 和最近 checkpoint。
- 恢复 phase、iteration、history、attack_surface、coverage、candidate_findings、confirmed_findings、assets、steering_queue。
- 不承诺后台 daemon、多客户端 attach、并发 session 队列。

## 7. TUI 架构

TUI 使用 Textual + Rich，参考 `research/AIRecon` 的成熟做法。

MVP Demo 最小 TUI：

- 状态栏：session_id、target、phase、iteration、active_tool、status。
- Agent 输出面板：文本消息、状态、错误。
- Tools 面板：tool_name、status、risk、摘要。
- Findings 面板：title、severity、status、evidence count。
- Assets 面板：address、ports、services。
- Evidence 面板：evidence_id、source_tool、summary、hash。
- Coverage 面板：tested/untested、vuln_type、status。
- Approval modal：展示 risk_level、target、proposed_action，返回 authorize/cancel。

TUI 读取 SQLite 快照，并订阅运行时事件更新。Demo 版不负责复杂任务创建。

## 8. Export / Import 架构

### 8.1 导出包格式

Standalone 导出统一 `report.tar.gz`：

```text
report.tar.gz
  manifest.json
  conversation.jsonl
  assets.json
  vulnerabilities.json
  evidence.json
  attack_surface.json
  coverage.json
  checkpoints/
  evidence/
```

`manifest.json` 至少包含：format_version、session_id、target、scope、created_at、exported_at、node_version。

### 8.2 平台导入

平台 `/api/sync/import`：

1. 校验包格式和 manifest。
2. 创建 Conversation。
3. 导入 messages。
4. 导入 assets。
5. 导入 vulnerabilities。
6. 导入 evidence metadata。
7. 导入或汇总 attack surface 和 coverage。
8. 写 audit log。
9. 返回 conversation_id、assets_imported、vulns_imported、evidence_imported、warnings。

导入后，前端会话页、资产页、漏洞页和证据详情应使用同一套 API 展示。

## 9. 平台协议

平台 -> Node：

- `task_assign`
- `user_steer`
- `user_interrupt`
- `user_input`

Node -> 平台：

- `status_update`
- `tool_output`
- `asset_discovered`
- `vuln_found`
- `evidence_created`
- `request_decision`
- `checkpoint_update`
- `task_complete`
- `task_error`

消息必须包含 `conversation_id` 或 `session_id`，工具调用必须包含稳定 `tool_run_id`，用于 UI 合并和恢复去重。

## 10. 安全边界

- Scope Gate：工具目标必须落在授权 scope 内。
- Risk Gate：intrusive/destructive 操作必须授权。
- Evidence Gate：confirmed finding 必须绑定 evidence_ids。
- Finding Quality Gate：confirmed finding 必须可复现、可解释、可追踪。
- Sandbox：工具执行在 DockerSandbox 内完成。
- Audit：平台模式关键操作写入 audit_log；standalone 导出包包含本地审计事件。
- Credential：凭据不得明文出现在日志、导出报告或 UI 默认视图中。

## 11. 当前非目标

这些不属于 MVP Demo：

- RabbitMQ、多实例 WebSocket 广播、生产级 ACK/离线补传。
- 多节点调度策略和任务队列。
- 后台 daemon、多客户端 attach、并发 standalone session 队列。
- 完整 RBAC、组织、多租户。
- 代码审计、应急响应、日志分析、CTF Node。
- 知识库/记忆注入、完整 Skill runtime、子代理和并行工具执行。
- 完整报告中心、模板管理、审批流。
