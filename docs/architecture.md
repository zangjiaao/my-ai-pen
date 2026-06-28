# 架构设计文档 — AI 安全运营平台

> 来源: `vision.json` V2.0 | 生成时间: 2026-06-28

---

## 1. 架构总览

### 1.1 系统架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                         用户交互层                                │
│                                                                  │
│   ┌─────────────────────┐    ┌─────────────────────┐             │
│   │  平台 Web 控制台     │    │  节点 Web 控制台     │             │
│   │  React + shadcn/ui   │    │  (V2+ 节点本地)      │             │
│   └──────────┬──────────┘    └─────────────────────┘             │
└──────────────┼───────────────────────────────────────────────────┘
               │
        WebSocket + REST API
               │
┌──────────────┼───────────────────────────────────────────────────┐
│                         平台核心服务层                             │
│                                                                  │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│   │ 会话引擎  │ │ 资产引擎  │ │ 漏洞引擎  │ │ 事件总线  │          │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│   ┌──────────┐ ┌──────────┐ ┌──────────────────────┐           │
│   │ 节点编排  │ │ 情报引擎  │ │     平台 Agent       │           │
│   └──────────┘ └──────────┘ └──────────────────────┘           │
│                                                                  │
│   ┌──────────────────────────────────────────────────┐          │
│   │              PostgreSQL 数据库                     │          │
│   │   Asset | Vulnerability | Conversation | Message │          │
│   │   Node | Event | User/Role (V5+)                 │          │
│   └──────────────────────────────────────────────────┘          │
└──────────────┬───────────────────────────────────────────────────┘
               │
        WebSocket (实时双向)
               │
┌──────────────┼───────────────────────────────────────────────────┐
│                     节点层（可扩展）                               │
│                                                                  │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│   │ 渗透 Node │ │ 代码审计  │ │ 应急响应  │ │ CTF Node │  ...     │
│   │ (MVP)    │ │ Node(V3) │ │ Node(V3) │ │ (V4)    │          │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 设计哲学

| 原则 | 说明 |
|------|------|
| **平台-节点解耦** | 平台持有通用对象（Asset/Vuln/Conversation），节点通过标准协议接入 |
| **协议驱动** | 平台与节点的所有交互由 WebSocket 消息类型和 REST API 定义 |
| **信息中心模式** | 平台作为共享信息中心，不同 Node 围绕同一 Asset/Finding/Evidence 协同 |
| **对话原语** | 所有安全活动统一建模为 Conversation → Message，自然语言为第一交互原语 |
| **数据可追溯** | 每个 Vulnerability 可追溯至原始 Conversation → Message → ToolRun → Evidence |

---

## 2. 平台核心服务层设计

### 2.1 会话引擎

```
┌─────────────────────────────────────────┐
│              会话引擎                     │
│                                         │
│  会话生命周期管理                         │
│  ┌───────────────────────────────┐      │
│  │ created → running → paused    │      │
│  │   ↓         ↓         ↓       │      │
│  │ completed  failed   running   │      │
│  └───────────────────────────────┘      │
│                                         │
│  会话上下文 (conversation.context json)   │
│  - execution_plan: 执行计划              │
│  - discovered_assets: [asset_id]        │
│  - vulns_list: [vuln_id]               │
│  - agent_state: {phase, progress}       │
│  - scope: {allow, deny}                 │
└─────────────────────────────────────────┘
```

**核心职责**：
- 会话的创建、暂停、恢复、终止
- 维护会话-节点绑定关系
- 管理会话上下文（context JSON 字段）
- 会话事件的发布（通过事件总线）

**API 端点**：
- `POST /api/conversations` — 创建会话
- `GET /api/conversations/:id` — 查询会话详情
- `PATCH /api/conversations/:id` — 更新会话（暂停/继续/终止）
- `GET /api/conversations?status=active&node_type=pentest` — 列表查询
- `DELETE /api/conversations/:id` — 归档/删除

### 2.2 资产引擎

```
┌─────────────────────────────────────────┐
│              资产引擎                     │
│                                         │
│  资产类型                                │
│  - IP/域名 (host)                       │
│  - Web应用 (web_app)                    │
│  - 云服务 (cloud_service)               │
│  - 代码仓库 (code_repo)                 │
│  - 日志源 (log_source)                  │
│  - CTF环境 (ctf_env)                    │
│                                         │
│  资产来源                                │
│  - manual: 用户手动添加                  │
│  - agent_discovered: Agent自动发现       │
└─────────────────────────────────────────┘
```

**核心职责**：
- 资产的增删改查（CRUD）
- 支持异构资产通过 `properties` JSON 字段扩展
- 资产-漏洞/事件/会话关联
- Agent 自动发现资产的验证与入库

**Asset Schema**：
```json
{
  "id": "uuid",
  "name": "string",
  "address": "string (IP/域名/URL)",
  "type": "enum(host|web_app|cloud_service|code_repo|log_source|ctf_env|...）",
  "tags": ["string"],
  "group_id": "uuid|null",
  "properties": {
    // 类型特定的扩展字段
    "host": { "open_ports": [80,443], "os": "Linux" },
    "web_app": { "url": "https://...", "tech_stack": ["nginx","php"] }
  },
  "source": "enum(manual|agent_discovered)",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

### 2.3 漏洞引擎

**核心职责**：
- 漏洞的 CRUD 与状态流转
- 漏洞-会话-节点-证据的全链路关联
- 复测结果处理

**状态机**：
```
待确认 (pending) ──验证通过──→ 已确认 (confirmed)
    │                              │
    └──验证失败──→ 误报 (false_positive)
                                   │
                     ┌─────────────┼─────────────┐
                     ↓             ↓             ↓
                 已报告      已修复 (fixed)   接受风险
                (reported)                  (accepted)
```

**Vulnerability Schema**：
```json
{
  "id": "uuid",
  "title": "string",
  "severity": "enum(critical|high|medium|low|info)",
  "cvss": "float|null",
  "cve_id": "string|null",
  "asset_id": "uuid",
  "conversation_id": "uuid",
  "node_id": "uuid",
  "description": "string",
  "poc": "string|null",
  "remediation": "string|null",
  "confidence": "enum(high|medium|low)",
  "status": "enum(pending|confirmed|reported|fixed|accepted|false_positive)",
  "evidence_ids": ["uuid"],
  "discovered_at": "timestamp",
  "updated_at": "timestamp"
}
```

### 2.4 事件总线

- 会话事件：conversation.created / conversation.status_changed
- 节点事件：node.registered / node.offline / node.heartbeat
- Agent 事件：task.started / task.phase_changed / task.completed
- 安全事件：vuln.found / vuln.confirmed / vuln.retested

### 2.5 多会话隔离与连续性

**核心原则**：会话是独立的，切换只是 UI 视角移动，不影响底层执行。

```
┌─ 浏览器 ──────────────────────────────────────────────────┐
│  MessageBuffer { conversation_id → Message[] }            │
│                                                           │
│  切换到 session-2: 从本地 buffer 渲染 → API 补漏 → 显示    │
│  切回 session-1: buffer 中已有切换期间到达的新消息          │
│  不需要"从头开始"——消息一直在推送和缓冲                      │
└──────────────────────────────────────────────────────────┘
```

**实现要点**：

- **单一 WebSocket 连接**：浏览器只维持一条 WS 连接。所有会话的消息通过同一条连接推送，`conversation_id` 字段路由到对应的 buffer
- **消息即时持久化**：每条消息到达平台后立即写 PostgreSQL。切换会话时前端调 `GET /api/conversations/:id/messages?after={last_seen_id}` 补全切换期间可能遗漏的消息
- **Node 侧会话独立**：每个 Session 有独立的 `AgentState`（phase、iteration、history、findings）。Session 队列管理的是执行顺序——排队的 Session 状态保持不动，轮到执行时从 Checkpoint 恢复
- **用户侧无感知**：你从 session-1 切到 session-2 再切回来，session-1 的消息流不间断——Agent 的输出持续追加到 buffer 和数据库，不管你当前在看哪个页面

### 2.5 节点编排

**核心职责**：
- 节点注册（Token 认证）
- 节点健康检查（心跳超时自动标记离线）
- 节点能力发现（node_type + supported_operations）
- Task 分配与路由

**节点注册流程**：
```
1. 管理员在节点管理页创建节点 → 生成注册 Token
2. 用户部署节点 → 配置 Token + 平台地址
3. 节点启动 → WebSocket 连接 + Token 认证
4. 平台验证 Token → 注册节点 → node.registered 事件
5. 节点定期发送 heartbeat → 平台更新 last_heartbeat
```

---

## 3. Agent 架构设计

### 3.1 平台 Agent

```
┌─────────────────────────────────────────┐
│              平台 Agent                  │
│                                         │
│  输入：用户自然语言 / 用户选择操作        │
│                                         │
│  能力域：                                │
│  ┌─────────────────────────────────┐    │
│  │ 意图识别 → 会话类型 + 节点路由    │    │
│  │ 数据操作 → 资产/漏洞 CRUD        │    │
│  │ 会话协同 → 标题/摘要/上下文管理   │    │
│  │ 节点管理 → 状态查询/日志获取      │    │
│  │ 安全知识 → 漏洞原理/修复/情报查询  │    │
│  └─────────────────────────────────┘    │
│                                         │
│  输出：会话操作 / API 调用 / 节点调度    │
└─────────────────────────────────────────┘
```

**路由规则**：
- 自然语言模式：平台 Agent 判断意图 → 创建会话 → 路由到对应节点
- 直连模式：用户直接选择会话类型和节点 → 平台校验参数 → 直接调度节点

### 3.2 渗透测试 Node 内部架构

```
┌──────────────────────────────────────────────────────────────┐
│                     渗透测试 Node                             │
│                                                              │
│  ┌─────────────┐     ┌──────────────────┐                   │
│  │ Task Intake  │────→│  Policy Engine   │                   │
│  │ parse msg    │     │  scope / risk    │                   │
│  └─────────────┘     └────────┬─────────┘                   │
│                               │ OK / Blocked                 │
│  ┌────────────────────────────┼──────────────────────────┐  │
│  │              Runtime Adapter (Node Runtime Contract)  │  │
│  │          统一事件接口 │ 证据接口 │ Finding 接口         │  │
│  └────────────────────────────┼──────────────────────────┘  │
│                               │                              │
│  ┌────────────────────────────┼──────────────────────────┐  │
│  │          Agent Runtime (PydanticAI MVP)               │  │
│  │                                                        │  │
│  │  ┌──────────────────┐   ┌─────────────────┐           │  │
│  │  │Agent Orchestrator│←──│Workflow Engine  │           │  │
│  │  │  Playbook选择     │   │  状态机调度      │           │  │
│  │  │  阶段计划生成     │   │  检查点管理      │           │  │
│  │  └────────┬─────────┘   └────────┬────────┘           │  │
│  │           │                      │                     │  │
│  │  ┌────────┴──────────────────────┴─────────┐          │  │
│  │  │        Skill / Playbook Engine           │          │  │
│  │  │  可版本化技能和剧本管理                    │          │  │
│  │  └────────┬─────────────────────────────────┘          │  │
│  │           │                                            │  │
│  │  ┌────────┴─────────────────────────────────┐          │  │
│  │  │           Tool Gateway                    │          │  │
│  │  │  工具注册 │ 参数校验 │ 风险分级 │ 命令构建  │          │  │
│  │  └────────┬─────────────────────────────────┘          │  │
│  │           │                                            │  │
│  │  ┌────────┴─────────────────────────────────┐          │  │
│  │  │         Sandbox Runner                    │          │  │
│  │  │  Docker/Kali │ 超时 │ 资源限制 │ kill switch│        │  │
│  │  └────────┬─────────────────────────────────┘          │  │
│  │           │                                            │  │
│  │  ┌────────┴────────┬──────────────────────┐           │  │
│  │  │  Output Parser  │   Evidence Store     │           │  │
│  │  │  结构化输出解析   │   证据采集+摘要+Hash  │           │  │
│  │  └────────┬────────┴──────────┬───────────┘           │  │
│  │           │                   │                        │  │
│  │  ┌────────┴───────────────────┴───────────┐           │  │
│  │  │         Finding Verifier                │           │  │
│  │  │  复现验证 │ 交叉验证 │ 去误报 │ 防重复   │           │  │
│  │  └────────────────┬───────────────────────┘           │  │
│  └───────────────────┼───────────────────────────────────┘  │
│                      │                                       │
│  ┌───────────────────┴───────────────────────────────────┐  │
│  │              Platform Sync                             │  │
│  │  status_update │ tool_output │ vuln_found │ summary   │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 执行状态机

```
                    ┌──────────┐
                    │  START   │
                    └────┬─────┘
                         ↓
                    ┌──────────┐
             ┌──────│ precheck │──────┐
             │      └──────────┘      │
          failed/                  通过
          blocked                    │
             │                  ┌────┴─────┐
             │           ┌──────│   plan   │
             │           │      └──────────┘
             │       用户要求        │
             │       重新规划   ┌────┴─────┐
             │           │     │  recon   │
             │           │     └────┬─────┘
             │           │     无有效信息
             │           │     completed_no_findings
             │           │          │
             │           │     ┌────┴─────┐
             │           │     │   scan   │
             │           │     └────┬─────┘
             │           │     无候选Finding
             │           │          │
             │           │     ┌────┴─────┐
             │           │     │  verify  │
             │           │     └────┬─────┘
             │           │     需要授权/确认
             │           │          │
             │           │     ┌────┴─────┐
             │           │     │  report  │
             │           │     └────┬─────┘
             │           │          │
                    ┌────┴──────────┴─────┐
                    │ checkpoint (每阶段)  │
                    └─────────────────────┘
```

**阻塞条件与处理**：
| 条件 | 触发阶段 | 行为 |
|------|---------|------|
| target_unreachable | precheck | 停止，返回 PrecheckResult |
| scope_denied | precheck | 拒绝外部工具调用，提示扩充 scope |
| network_error | 任意 | 标记 blocked，等待网络恢复 |
| tool_missing | plan | 停止，列出缺失工具和版本要求 |
| no_attack_surface | recon | 生成摘要，completed_no_findings 状态 |
| needs_auth | plan/scan | 暂停，请求用户提供凭据 |
| high_risk_operation | scan/verify | 生成 ApprovalRequest，等待用户授权 |

### 3.4 Agent 主循环

渗透 Node 的每个 Task 运行一个 Agent Loop 实例。主循环按阶段推进，每个阶段内部以 **迭代循环** 运行：

```
Node Task → run()
    │
    ├── TaskIntake: 校验target+scope → 失败则report_blocked
    │
    ├── _run_phase(PRECHECK)  → target解析/连通性/scope合规
    ├── _run_phase(PLAN)      → Playbook选择/TaskPlan生成
    ├── _run_phase(RECON)     → 端口扫描/服务识别/目录枚举
    ├── _run_phase(SCAN)      → 漏洞扫描/候选Finding生成
    ├── _run_phase(VERIFY)    → 候选Finding复现/交叉验证/确认
    ├── _run_phase(REPORT)    → 摘要+报告素材+平台同步
    │
    └── TaskComplete / TaskFailed
```

**每个阶段的迭代循环**：

```python
while phase_iteration < MAX_ITERATIONS_PER_PHASE[phase]:
    # 0. 阶段转换检查 — 目标达成则提前退出
    if should_transition(phase): break

    # 1. 上下文管理 — Token预算超限→裁剪/压缩
    manage_context()

    # 2. 构建消息 — system prompt + phase prompt + dynamic context + history
    messages = build_turn_messages()

    # 3. LLM调用
    response = call_llm(messages)
    if response.has_tool_calls():
        text_only_count = 0
        # 4. 监督前检查 — 去重/scope/风险/授权
        # 5. 执行工具 — 串行/并行分组
        results = execute_tools(response.tool_calls)
        # 6. 证据采集
        collect_evidence(results)
    else:
        text_only_count += 1
        # 纯文本→触发监督机制(Reflector/Watchdog/Mentor)

    # 7. 检查点持久化
    save_checkpoint()
    phase_iteration += 1
```

**停止条件**：

| 条件 | 结果 |
|------|------|
| 所有阶段正常完成 | `completed` |
| precheck 失败（不可达/scope外） | `blocked` |
| 连续5次工具调用失败 | `failed` |
| recon 无开放端口/无Web服务 | `completed_no_findings` |
| scan 无候选Finding | `completed_no_findings` |
| 平台下发中断指令 | `cancelled` |
| 阶段超时（recon≤50轮, scan≤80轮） | 强制进入下一阶段 |

### 3.5 上下文管理

**Token 预算管理**（与 pentest-node-spec.md 一致）：

| 阈值 | 触发 | 动作 |
|------|------|------|
| < 60% | 无 | 正常运转 |
| 60-80% | 警告 | Level 1 裁剪 — 早期工具输出只保留摘要（首200+尾100字符）；保留所有漏洞/资产/授权消息；保留最近4条完整结果 |
| ≥ 80% | 紧急 | Level 2 LLM 压缩 — 使用结构化模板（借鉴 Pi 的 compaction prompt）；三次连续失败→熔断 |

**结构化压缩模板**（借鉴 Pi 的 Goal/Constraints/Progress/Decisions/Next Steps 格式）：

```markdown
将以下渗透测试对话历史压缩为结构化摘要。严格按以下模板输出：

## 目标 (Goal)
用户的核心测试意图和当前阶段的子目标。

## 约束 (Constraints)
scope 边界、WAF 情况、速率限制、已获取的认证状态。

## 进度 (Progress)
- 已完成: [具体的行动项和结果]
- 当前: [正在进行的操作]
- 剩余: [待完成的行动项]

## 关键决策 (Key Decisions)
- [Agent 做出的重要策略选择和原因]
- [用户授权的操作及其结果]

## 下一步 (Next Steps)
1. [明确的下一步行动 — 具体的工具和参数]
2. ...

## 必须保留 (Never Drop)
- 已确认漏洞: 标题 + 等级 + 位置 + 证据 ID
- 关键资产: IP + 端口 + 服务 + 版本
- 用户授权记录: 操作 + 时间 + 决定
```

**压缩保留优先级**：已确认漏洞（永不丢弃）> 用户授权决定 > scope边界 > 关键证据ID > 当前执行步骤

### 3.6 监督与防停滞

参考 AIRecon 成熟实践，采用**三级递进干预**：

| 级别 | 触发条件 | 机制 |
|------|---------|------|
| **Reflector** | 连续2轮纯文本 | 注入系统消息："请调用工具来取得进展，当前阶段目标是…" |
| **Watchdog** | 连续3轮纯文本 | 从分析文本提取候选shell命令→强制注入为工具调用 |
| **Mentor** | 连续4轮纯文本 | LLM分析最近20条对话→给出一句话建议+具体命令 |

**停滞检测**（独立于纯文本计数）：
- 同一工具连续调用≥3次 → 注入多样性提示
- 超过15轮无新Finding → 建议切换攻击类型或提前结束阶段
- 阶段耗时超过配置上限 → 强制phase_transition

---

## 4. 通信协议

### 4.1 协议分层

```
┌─────────────────────────────────┐
│      消息类型层 (msg_type)       │
│  定义业务语义                    │
├─────────────────────────────────┤
│      传输层 (WebSocket + REST)  │
│  帧格式、心跳、重连、序列化       │
└─────────────────────────────────┘
```

### 4.2 WebSocket 消息流示例

**一个典型的渗透测试会话消息流**：

```
1. 用户 → 平台        创建会话（选择渗透测试、输入目标）
2. 平台 → 节点        task_assign (conversation_id, target, scope, policy)
3. 节点 → 平台        status_update (phase=precheck, status=started)
4. 节点 → 平台        status_update (phase=precheck, status=completed)
5. 节点 → 平台        status_update (phase=recon, status=started)
6. 节点 → 平台        tool_output (tool=nmap, stream=stdout, line="80/tcp open http")
7. 节点 → 平台        tool_output (tool=nmap, stream=stdout, line="443/tcp open https")
8. 节点 → 平台        asset_discovered (host=192.168.1.100, ports=[80,443])
9. 节点 → 平台        status_update (phase=scan, status=started)
10. 节点 → 平台       request_decision (risk=destructive, question="是否执行SQL注入验证？")
11. 平台 → 节点        user_input (response="authorize")
12. 节点 → 平台       tool_output (tool=sqlmap, stream=stdout, line="parameter 'id' is vulnerable")
13. 节点 → 平台       vuln_found (title="SQL注入", severity=high, confidence=high)
14. 节点 → 平台       status_update (phase=report, status=started)
15. 节点 → 平台       task_complete (summary, report_artifacts)
```

### 4.3 运行中交互：Steer 与 Interrupt

Agent 执行期间，用户不是旁观者。三种交互模式覆盖不同场景：

| 模式 | 触发 | 行为 | 例子 |
|------|------|------|------|
| **Steer（纠偏）** | 用户发送消息 | 注入为下轮 LLM 调用的 system 消息，**不中断当前工具执行** | "别扫 8080，那是 CDN" — Agent 下轮自动跳过 |
| **Interrupt（中断）** | 用户点「停止」 | 立即中断当前操作，保存 Checkpoint | "停！你扫的是生产环境" — Agent 立刻停止 |
| **Respond（响应）** | Agent 发确认卡片 | 用户点「授权/取消」— Agent 继续或调整 | sqlmap 执行确认 — 用户点授权 |

```
Agent 在执行 nmap (60s)...
         │
用户: "扫完别碰 22 端口，那是跳板机"
         │
         ▼ 不中断 nmap，消息排队
nmap 完成 → 下轮 LLM 调用前注入 steering 消息
         │
Agent: "收到，跳过 22 端口。继续扫描其他端口..."  ← Agent 自动纠偏
```

**实现**：Node 维护一个 `steering_queue`。每轮 LLM 调用前，队列中的消息作为 system message 注入：
```python
# Agent Loop 每轮开始时
if self.steering_queue:
    for msg in self.steering_queue:
        self.history.append({"role": "system",
            "content": f"[用户纠偏] {msg.text}"})
    self.steering_queue.clear()
```

**UX**：Agent 执行期间输入框保持可用。用户发送的消息自动标记为"纠偏"模式（非 Interrupt），对话区用左边框标识区别于常规消息。

### 4.4 消息可靠性

- **消息去重**：每个消息带唯一 msg_id，接收端去重
- **有序投递**：基于 session_id 的消息队列保证同一会话消息有序
- **离线缓存**：节点离线时平台缓存待发消息，重连后按序补传
- **ACK 机制**：关键消息（task_assign、user_interrupt）需节点 ACK，超时重试
- **优雅中断**：user_interrupt 消息通过高优先级通道发送，节点收到后立即暂停并在限定时间内响应
- **Steer 消息不丢**：steer 消息与普通消息共用持久化通道，节点离线时暂存平台，重连后补传

---

## 5. 安全控制架构

### 5.1 多层防护模型

```
┌──────────────────────────────────────────────────────────────┐
│  用户授权层                                                    │
│  - 会话创建时的 scope 定义                                     │
│  - 高风险操作的实时 Approval                                   │
├──────────────────────────────────────────────────────────────┤
│  策略引擎层 (Policy Engine)                                    │
│  - Target scope 校验 (目标地址 ∈ scope.allow)                  │
│  - 工具风险等级校验 (risk_tier ≤ max_risk)                     │
│  - 禁止清单过滤 (forbidden_actions ∩ action = ∅)              │
├──────────────────────────────────────────────────────────────┤
│  工具网关层 (Tool Gateway)                                     │
│  - 工具参数构建 → 注入防护                                     │
│  - 参数校验 → 格式 + 范围检查                                  │
│  - 速率限制 → max_parallel_tools ≤ limit                      │
├──────────────────────────────────────────────────────────────┤
│  沙箱执行层 (Sandbox Runner)                                   │
│  - Docker 容器隔离                                            │
│  - 网络策略 (egress filtering)                                 │
│  - 资源限制 (CPU/memory/disk)                                  │
│  - 超时终止 + Kill Switch                                     │
├──────────────────────────────────────────────────────────────┤
│  证据门控层 (Evidence Gate)                                    │
│  - Finding 必须绑定证据 (ToolRun + Evidence)                   │
│  - 置信度评估 ≥ threshold                                     │
│  - 复现步骤 + 修复建议 完整性检查                              │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 风险等级定义

| 等级 | 标签 | 典型操作 | 控制策略 |
|------|------|---------|---------|
| Level 0 | observe | nmap -sV (服务探测), whois | 无需授权，自动执行 |
| Level 1 | safe | nuclei (非破坏性模板), httpx | 无需授权，自动执行 |
| Level 2 | intrusive | sqlmap --risk=2, 目录暴力枚举 | 需用户确认后方可执行 |
| Level 3 | destructive | sqlmap --risk=3, 漏洞利用, 密码爆破 | 必须显式授权，每次执行前生成确认卡片 |

### 5.3 审计体系

企业级安全平台的审计必须覆盖两路：**Agent 的自动化行为**和**人的手动操作**。

**核心原则**：
- 审计日志 **只追加不修改不删除**（append-only immutable log）
- 应用的数据库用户对审计表只有 INSERT 和 SELECT 权限，没有 UPDATE/DELETE
- 每条记录包含：谁（actor）、做了什么（action）、对什么资源（resource）、结果（status）、来源IP

```sql
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_type audit_actor_type NOT NULL,  -- 'user', 'agent', 'node', 'system'
    actor_id UUID NOT NULL,
    actor_name TEXT,                        -- 操作时的可读名称
    action TEXT NOT NULL,                   -- 操作类型标识
    resource_type TEXT,                     -- 'session', 'vulnerability', 'asset', 'node', 'conversation'
    resource_id UUID,
    detail JSONB,                           -- 操作详细上下文
    ip_address INET,                        -- 来源 IP
    user_agent TEXT,                        -- 浏览器 UA
    conversation_id UUID,                   -- 关联会话
    status TEXT NOT NULL                    -- 'success', 'failure', 'denied'
);

-- 按月分区，支持长期保留
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp DESC);
CREATE INDEX idx_audit_actor ON audit_log (actor_type, actor_id);
CREATE INDEX idx_audit_action ON audit_log (action, timestamp DESC);
CREATE INDEX idx_audit_conversation ON audit_log (conversation_id);
```

#### 审计事件清单

**人的操作（必须审计）**：
| action | 触发时机 | detail 内容 |
|--------|---------|------------|
| `auth.login` | 用户登录成功 | method (oauth2/password), ip |
| `auth.login_failed` | 登录失败 | method, reason, attempt_count |
| `auth.logout` | 用户登出 | — |
| `session.create` | 创建渗透会话 | node_type, target, scope |
| `session.delete` | 删除会话 | reason |
| `vuln.status_change` | 修改漏洞状态 | old_status, new_status, reason |
| `asset.create` / `asset.update` / `asset.delete` | 手动资产管理 | changed_fields |
| `node.register` / `node.disable` | 节点注册/禁用 | node_type, node_ip |
| `approval.authorize` / `approval.cancel` | 用户响应授权请求 | risk_level, action_approved |

**Agent 的操作（自动记录）**：
| action | 触发时机 | detail 内容 |
|--------|---------|------------|
| `task.start` / `task.complete` / `task.error` | Node 任务生命周期 | phase, iteration_count, findings_count |
| `tool.execute` | 每个 `execute` 调用 | command, risk_level, exit_code, duration_ms |
| `finding.create` | 创建候选 Finding | vuln_type, severity, confidence |
| `finding.confirm` / `finding.reject` | 验证 Finding | evidence_ids, verification_tier |
| `approval.request` | Agent 申请授权 | risk_level, proposed_action |
| `asset.discover` | Agent 发现新资产 | asset_type, address, ports |

**系统的操作**：
| action | 触发时机 |
|--------|---------|
| `node.connect` / `node.disconnect` | 节点 WebSocket 连接状态变化 |
| `system.error` | 未捕获的系统异常 |

#### MVP vs V2+ 审计范围

| MVP 必须做 | V2+ 补充 |
|-----------|---------|
| 审计日志表 + 写入基础设施 | 审计查询/浏览 UI |
| 人的操作：登录、会话创建/删除、漏洞状态变更、授权决定 | 审计报表导出 |
| Agent 操作：工具执行、Finding 创建/确认/拒绝、资产发现 | 基于审计的合规报告 (SOC2/ISO27001) |
| 系统操作：节点连接/断开、系统异常 | 审计异常检测（异常登录模式等） |
| 数据库层面的 append-only 权限 | 审计日志保留策略 / 自动归档 |
| — | 操作回放（重放一个会话中 Agent 的所有操作） |

---

## 6. 技术选型与数据流

### 6.1 技术栈详细

```
┌───────────────────────────────────────────────────────────────┐
│ 前端 (平台 Web 控制台)                                         │
│ React 18+ + shadcn/ui + Tailwind CSS                          │
│ + Zustand (状态管理)                                           │
│ + TanStack Query / React Query (服务端数据请求)                │
│ + WebSocket 客户端 (reconnecting-websocket)                   │
│ + Markdown 渲染 (react-markdown)                              │
├───────────────────────────────────────────────────────────────┤
│ 平台后端                                                       │
│ FastAPI (Python 3.11+)                                        │
│ + WebSocket (FastAPI WebSocket)                               │
│ + PostgreSQL (asyncpg / psycopg)                              │
│ + RabbitMQ — 节点离线消息缓存 + 多实例WebSocket广播            │
├───────────────────────────────────────────────────────────────┤
│ 节点运行时                                                     │
│ Python 3.11+ + FastAPI + asyncio                              │
│ + 双模式：平台模式(WebSocket) / 独立模式(CLI)                   │
│ + Docker SDK (沙箱管理)                                        │
│ + SQLite (本地任务记录) + 文件目录 (证据存储)                   │
│ + 离线结果导出(tar.gz) + 平台同步(REST)                        │
├───────────────────────────────────────────────────────────────┤
│ Agent Runtime                                                 │
│ PydanticAI (MVP) → 工具Schema + 结构化输出 + HITL              │
│ 通过 Runtime Adapter 解耦 → 可替换 LangGraph / Pi / Hermes    │
├───────────────────────────────────────────────────────────────┤
│ LLM 接入                                                       │
│ LiteLLM                                                        │
│ 支持: OpenAI系列, Claude系列, 本地Ollama, LM Studio, 企业模型  │
├───────────────────────────────────────────────────────────────┤
│ 沙箱环境                                                       │
│ Docker (Kali Linux 镜像)                                      │
│ + 资源限制 (cgroups)                                          │
│ + 网络策略 (iptables/nftables)                                 │
│ + 工作目录映射 (只读配置 + 读写输出)                            │
└───────────────────────────────────────────────────────────────┘
```

### 6.2 数据流总览

```
用户浏览器
    │  WebSocket
    ↓
平台 Web 控制台 (React)
    │  WebSocket + REST
    ↓
平台后端 (FastAPI)
    │  PostgreSQL
    ↓
    │  WebSocket (task_assign / user_interrupt)
    ↓
节点 (Python + FastAPI)
    │
    ├── Agent Runtime (PydanticAI)
    │       │
    │       ├── Tool Gateway → Docker 沙箱 → 安全工具
    │       │
    │       ├── Evidence Store → 本地文件系统
    │       │
    │       └── Finding Verifier → vuln_found → 平台
    │
    └── SQLite (NodeTask / ToolRun / Finding / Checkpoint)
```

---

## 7. 跨节点协同机制（V3+）

### 7.1 信息中心模式

平台持有共享信息中心，不同 Node 围绕同一对象协同：

```
                    ┌─────────────────┐
                    │   平台信息中心    │
                    │                 │
                    │  Asset 池       │
                    │  Vulnerability 池│
                    │  Evidence 池    │
                    │  Conversation 池│
                    └───┬───┬───┬─────┘
                        │   │   │
              ┌─────────┘   │   └─────────┐
              ↓             ↓             ↓
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ 渗透 Node │ │ 代码审计  │ │ 应急响应  │
        │          │ │  Node    │ │  Node    │
        └──────────┘ └──────────┘ └──────────┘
```

### 7.2 协同示例：代码审计 → 渗透验证

```
代码审计 Node                    平台                      渗透测试 Node
    │                             │                            │
    │── CodeFinding ─────────────→│                            │
    │   (file/line/route/param)   │                            │
    │                             │                            │
    │                             │←── 用户授权: 动态验证 ────│
    │                             │                            │
    │                             │── task_assign ────────────→│
    │                             │   (含 CodeFinding 数据)    │
    │                             │                            │
    │                             │   渗透 Node 提取路由和参数  │
    │                             │   构造 POC 进行动态验证     │
    │                             │                            │
    │                             │←── ExploitValidationResult │
    │                             │   (validated/false_positive│
    │                             │    /needs_manual_review)   │
    │                             │                            │
    │  更新为 Vulnerability       │                            │
    │  或标记为误报/待人工         │                            │
```

---

## 8. 部署架构

### 8.1 MVP 部署拓扑

```
┌─────────────────────────────────────────────────────┐
│  服务器 A (平台)                                      │
│                                                     │
│  ┌─────────────────────┐  ┌────────────────────┐   │
│  │ 平台前端 (Nginx)     │  │ PostgreSQL          │   │
│  │ 平台后端 (FastAPI)   │  │                     │   │
│  └─────────────────────┘  └────────────────────┘   │
└─────────────────────────────────────────────────────┘
                    │ WebSocket + REST
┌───────────────────┴─────────────────────────────────┐
│  服务器 B (节点)                                      │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ Python Node Runtime + PydanticAI Agent       │  │
│  │                                              │  │
│  │  ┌──────────────────────────────────────┐   │  │
│  │  │ Docker 沙箱 (Kali 工具镜像)            │   │  │
│  │  │ - nmap, nuclei, sqlmap, gobuster...   │   │  │
│  │  │ - 资源限制 + 网络隔离                  │   │  │
│  │  └──────────────────────────────────────┘   │  │
│  │                                              │  │
│  │  SQLite + 证据文件目录                       │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 8.2 扩展部署（V3+）

- 平台层可水平扩展（无状态服务 + PostgreSQL 主从）
- 节点层按类型独立部署和扩展
- WebSocket 连接通过 RabbitMQ 在平台实例间广播
- 证据文件可迁移至对象存储（MinIO / S3）

---

*文档状态：草稿 | 基于 plan.docx V2.0 提取*
