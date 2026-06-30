# 产品路线图 — AI 安全运营平台

- 来源：`vision.json`、`docs/prd.md`、`docs/architecture.md`、`docs/pentest-node-spec.md`、当前代码实现
- 最近校准：2026-06-30
- 当前结论：**MVP Alpha 单节点闭环已完成；完整可演示 MVP 仍未完成。** 当前应继续补齐“客户演示所需的结果可见性、报告输出、运行稳定性和部署说明”，暂不进入多节点、子代理、知识库/记忆增强等扩展方向。

---

## 0. 本次清理结论

原 roadmap 的主要问题不是缺任务，而是状态源太多：前面的“大型能力清单”、后面的 P0/P1/P2、V2/V3 合并章节、启动前检查清单、下一阶段定义之间互相重复，而且有些状态已经和代码不一致。

本次清理后的规则：

- `[x]`：当前代码有可运行实现，并已有脚本或页面路径能验证。
- `[~]`：已有主链路，但仍缺关键体验、边界处理、数据完整性或生产化能力。
- `[ ]`：未实现，或只是静态页面、内存原型、按钮占位、文档规划。

本文件只保留路线图和可执行差距，不再保留历史审计长文。

---

## 1. 当前里程碑状态

| 里程碑 | 状态 | 说明 |
|---|---:|---|
| MVP Alpha：单节点平台闭环 | [x] | 平台登录、节点注册、WebSocket 下发任务、Node 执行、授权确认、资产/漏洞/证据/消息入库、前端刷新恢复已具备。 |
| MVP Demo：客户可演示版本 | [~] | 核心链路可跑，但还缺报告输出、演示脚本稳定性、证据文件可追溯、运行/部署说明和少量 UI 收尾。 |
| MVP Production：早期试用版本 | [ ] | 缺 ACK/心跳/离线补传、生产部署、权限/组织边界、审计完整性、节点健康与失败恢复。 |
| Post-MVP 扩展 | [ ] | 多节点策略、子代理、知识库/记忆增强、TUI/独立模式、Skill 深度接入、报告中心等。 |

---

## 2. 已实现但旧 roadmap 没有正确勾选的能力

这些能力在旧文档前半部分仍写成未完成或部分完成，但当前代码已经具备可运行实现：

- [x] **Markdown 与表格渲染**：`MessageRenderer` 已支持标题、列表、代码块、引用、表格和基础 inline markdown。
- [x] **工具卡片长输出体验**：工具卡片默认收起，可展开；长输出会换行并限制滚动区域，避免撑破右侧面板。
- [x] **工具卡片去重/合并**：前端按 `tool_run_id` 合并 running/done/fail 更新，避免恢复会话时同一工具调用显示两张卡。
- [x] **会话持久化恢复**：后端 `conversation_snapshot` 成为恢复视图的事实源；前端使用 TanStack infinite query 加载历史消息，刷新和切换页面后能恢复消息、资产、漏洞、证据、待处理和进度。
- [x] **会话删除一致性**：删除会话会清理关联消息、资产、漏洞、证据；前端删除失败会展示错误，404 会清理本地 active 会话。
- [x] **资产/端口入库与详情**：Agent 发现的资产、端口和服务会写入 `Asset.properties`，资产页、会话卡片、右侧面板共用资产详情弹窗。
- [x] **漏洞入库与详情**：Agent 发现的漏洞会写入漏洞库，漏洞页、会话卡片、右侧面板共用漏洞详情弹窗，并展示资产、证据、会话和节点来源。
- [x] **漏洞状态约束**：漏洞 PATCH 已有基础生命周期 transition validation，不再是任意状态直接覆盖。
- [x] **漏洞复测入口**：`/api/vulnerabilities/{id}/retest` 已能创建聚焦复测会话并在有在线节点时启动。
- [x] **Evidence Gate**：Node `confirm_finding` 要求 evidence_ids；平台对缺证据的 confirmed finding 会降级或补 placeholder，漏洞详情能展示证据摘要。
- [x] **审计日志覆盖扩大**：已覆盖登录、会话创建/更新/删除/steer、资产 CRUD、漏洞状态、复测、finding confirm/reject、tool.execute 等关键路径。
- [x] **数据库索引与 schema repair**：已有 `0002_session_persistence_repair.py`，补充 assets/vulnerabilities/evidence 相关字段和索引。
- [x] **OpenAI SDK 兼容实现**：Node 运行时已从 LiteLLM 改为 OpenAI SDK 兼容接口，通过 `base_url` 支持 DeepSeek/Ollama/LM Studio/企业兼容服务。

---

## 3. 旧 roadmap 中与当前实现冲突的描述

以下描述已不应继续保留为事实：

- **“Markdown 渲染未实现”**：已实现，包含表格。
- **“漏洞状态 PATCH 可直接改状态，状态机未实现”**：已实现基础 transition validation。
- **“复测 API 未实现”**：已实现复测会话创建和在线节点派发；只是还没有独立 `RetestResult` 模型。
- **“资产中的 Agent 发现、会话、漏洞实时关联未实现”**：主链路已实现，剩余是资产历史、审计历史和更完整的关系视图。
- **“索引优化未落地”**：核心会话/资产/漏洞/证据索引已在 repair migration 中落地；仍可继续做生产级索引优化。
- **“下一阶段定义为 MVP Alpha”**：Alpha 已完成，不应继续作为下一阶段。下一阶段应是 **MVP Demo**。
- **“P1 全部完成意味着完整 MVP 完成”**：不成立。P1 主要补齐结果可见性、安全门禁和会话恢复；完整演示还需要报告、部署、稳定性和验收脚本。
- **“平台增强/V2、多节点/V3 并入当前 MVP”**：容易误导。多节点策略、子代理、知识库/记忆增强、独立模式和 TUI 都应放到 MVP 之后。

---

## 4. 当前已完成能力基线

### 4.1 平台前端

- [x] 登录页、主布局、三栏对话页、会话列表、新建会话、重命名、删除。
- [x] 会话 ID 展示/复制入口。
- [x] 会话消息恢复、分页懒加载、刷新恢复、会话切换恢复。
- [x] Markdown/table 渲染、状态消息、工具卡片、漏洞卡片、资产卡片、确认卡片。
- [x] 右侧面板展示发现、进度、待处理、证据列表。
- [x] 授权确认 UX：确认卡、待处理列表、通知、倒计时、定位。
- [x] 资产管理页：列表、搜索/过滤、手工创建、详情弹窗、相关漏洞摘要。
- [x] 漏洞管理页：列表、过滤、详情弹窗、状态变更、复测入口。
- [x] 节点管理页：节点注册、token 生成/重置、删除、基础状态。
- [~] Skill/知识库/记忆页面：有基础页面或简单 API，但不是完整产品能力。

### 4.2 平台后端

- [x] JWT 登录、refresh、当前用户接口。
- [x] Conversation CRUD、状态机、消息分页、会话快照、steer/interrupt 路由。
- [x] WebSocket 用户连接、节点连接、任务下发、会话订阅、节点消息持久化。
- [x] Asset/Vulnerability/Evidence/Audit 核心模型与 API。
- [x] Agent 发现资产、漏洞、证据后的入库和 user/conversation/node 关联。
- [x] 漏洞详情关联资产和证据；资产详情关联漏洞摘要。
- [x] 审计 API 和基础权限过滤。
- [~] Node 健康、ACK、心跳、离线补传、重连补偿仍未实现。
- [~] 组织/RBAC/多租户字段存在部分基础，但资源模型还不是完整多租户隔离。

### 4.3 渗透 Node

- [x] 平台模式 WebSocket 客户端，接收 `task_assign` 并启动 Agent loop。
- [x] Task Intake：target/scope/DNS/TCP 预检，`host.docker.internal` 提示。
- [x] OpenAI SDK 兼容 LLM client。
- [x] DockerSandbox 平台模式接入，真实 Docker smoke 已覆盖。
- [x] execute/http/browser/workflow tools 基础接入。
- [x] scope/risk gate：越权目标阻断，高风险操作走授权。
- [x] evidence store、checkpoint_update、asset/vuln/evidence/status/task_complete 同步。
- [~] 阶段推进仍主要依赖 LLM 调用 `phase_transition`，不是强确定性工作流。
- [~] nmap/httpx/nuclei/sqlmap/gobuster/ffuf 等没有独立 ToolSpec，主要通过 `execute` 调用。
- [~] pause/resume、失败恢复、长任务恢复、kill switch 仍不完整。

### 4.4 测试与验收脚本

- [x] `scripts/alpha_smoke.py`：平台侧入库、审计、证据基础闭环。
- [x] `scripts/node_alpha_smoke.py`：Node intake/scope/approval/evidence。
- [x] `scripts/ws_alpha_smoke.py`：真实 `/ws` 用户/节点连接、任务、授权、完成和持久化。
- [x] `scripts/docker_sandbox_smoke.py` / `scripts/docker_sandbox_real_smoke.py`：DockerSandbox 合约与真实容器。
- [x] `scripts/alpha_browser_smoke.py`：真实前端闭环、刷新恢复、授权卡、Evidence 视图、长输出约束。
- [x] `scripts/session_recovery_smoke.py`：长会话恢复、分页、删除回归。
- [x] `scripts/session_integrity_check.py`：排查单会话消息/资产/漏洞/证据一致性。
- [x] `scripts/audit_coverage_smoke.py`：审计覆盖回归。

---

## 5. MVP Demo 剩余范围

这是下一阶段，不是 P2，也不是 Post-MVP。目标是让客户能看懂、能复现、能相信结果。

### P0：演示闭环稳定化

- [ ] 固化一条 DVWA/Juice Shop 演示脚本：从节点启动、发起测试、授权确认、发现资产/漏洞、查看证据、生成总结。
- [ ] 对真实 DVWA 跑一轮人工验收，记录 Agent 行为质量问题：重复输出、阶段误用、误报、漏报、错误工具选择。
- [ ] 收敛 Agent 阶段控制：禁止在错误 phase 调用不允许工具时重复失败；失败要进入可恢复路径，而不是刷屏。
- [ ] 明确“继续任务”和“重新开始”的协议：已有会话进度时默认 resume，只有用户明确重开才新建任务。
- [ ] 客户演示启动文档：平台、Node、靶场、环境变量、常见 localhost/host.docker.internal 问题。

### P1：结果可交付

- [ ] MVP 报告导出：基于会话快照导出 Markdown/HTML，包含目标、范围、资产、漏洞、证据摘要、时间线和免责声明。
- [ ] Evidence 详情页/弹窗：能从漏洞详情打开证据详情，展示 request/response、工具输出、hash、raw_ref 和来源工具。
- [ ] 证据原始文件同步策略：至少明确 demo 版只展示摘要/引用，或实现可下载 raw evidence。
- [ ] 漏洞详情补齐字段：复现步骤、影响、修复建议、证据列表、状态更新时间线。
- [ ] 资产详情补齐字段：端口/服务历史、来源会话、相关漏洞、最近扫描时间。

### P2：运行可观测与可靠性

- [ ] 审计日志 UI：至少能按会话查看关键事件，便于演示和问题排查。
- [ ] 节点健康与任务状态：展示在线状态、当前任务、最近心跳、失败原因。
- [ ] WebSocket ACK/心跳最小实现：避免 UI 误以为任务还在跑或节点仍在线。
- [ ] 更完整的错误归档：task_error、tool fail、scope block、approval cancel 都应在会话恢复后可见且不重复。
- [ ] 一键 smoke 验收脚本：聚合平台、Node、WS、浏览器、DockerSandbox 的主要测试，输出 demo readiness。

---

## 6. MVP 之后再做的能力

这些能力有价值，但不应阻塞 MVP Demo。

### Platform Post-MVP

- [ ] 归档会话、会话标签、批量管理。
- [ ] 附件上传和文件面板。
- [ ] 资产/漏洞分页 UI、复杂筛选、批量操作。
- [ ] 完整 RBAC、组织、多租户隔离。
- [ ] 报告中心：渗透报告、复测报告、模板管理、审批流。
- [ ] RabbitMQ 或任务队列化通信。

### Agent/Node Post-MVP

- [ ] 独立运行模式：`--standalone`、`status`、`logs --follow`、`adjust`、`stop`、`resume`。
- [ ] TUI 接真实 Agent 状态和快捷键操作。
- [ ] 离线导出/同步 CLI，并统一导出包与平台导入格式。
- [ ] 独立 ToolSpec：nmap/httpx/nuclei/sqlmap/gobuster/ffuf 等。
- [ ] 确定性 workflow engine、质量评分、反事实挑战、去重和误报控制。
- [ ] 完整 kill switch、资源限额、长任务恢复。

### Intelligence Post-MVP

- [ ] Skill 前后端接通：上传、校验、持久化、启用/禁用，并让 Agent 读取。
- [ ] 知识库持久化检索：向量 + BM25，提供 `knowledge_search` 工具。
- [ ] 记忆管理接数据库，并支持从会话学习。
- [ ] 多节点调度：能力发现、健康策略、负载策略、手动选择节点。
- [ ] 节点内子代理和并行工具执行。

---

## 7. 当前推荐下一步

下一步应继续做 **MVP Demo P0/P1**，不建议进入多节点、子代理、知识库/记忆增强。

推荐顺序：

1. 固化 DVWA/Juice Shop 演示脚本，并跑真实端到端验收。
2. 补 MVP 报告导出，让 Agent 成果能交付给客户。
3. 补 Evidence 详情入口和证据原文策略，保证漏洞不是只显示摘要。
4. 收敛 Agent 阶段错误和重复失败输出，提高演示稳定性。
5. 写一份启动/演示 runbook，降低现场演示风险。