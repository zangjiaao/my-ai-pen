# 产品需求文档 (PRD) — AI 安全运营平台

> 来源: `vision.json` V2.0 | 生成时间: 2026-06-28 | 阶段: MVP 设计

---

## 1. 产品概述

### 1.1 产品定位

AI 安全运营平台是一个以**自然语言对话**为核心交互模式的智能安全运营系统。它采用"平台+节点"架构，通过平台 Agent 与各专业节点 Agent 的协同，将渗透测试、代码审计、应急响应等安全任务转变为一站式、可观测、可干预、可追溯的智能闭环。

### 1.2 核心价值主张

| 维度 | 传统方式 | 本平台 |
|------|---------|--------|
| 交互模式 | 多终端/多工具切换 | 统一对话入口 |
| 技能门槛 | 依赖专家手动操作 | AI Agent 辅助执行 |
| 执行过程 | 黑盒、不可观测 | 实时透明、可干预 |
| 数据管理 | 分散文件/手动报告 | 结构化自动沉淀 |
| 知识积累 | 个人经验 | 系统化知识库 + 可复用 Skill/Playbook |

### 1.3 目标用户

- **主要用户**：安全工程师 / 渗透测试工程师 —— 需要 AI 辅助高效完成漏洞发现、验证、报告闭环
- **次要用户**：安全运营团队管理者、代码审计工程师、应急响应工程师
- **扩展用户**：CTF 参赛团队、安全研究人员

---

## 2. 系统架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│                     用户交互层                               │
│         平台 Web 控制台 │ 节点 Web 控制台                     │
├─────────────────────────────────────────────────────────────┤
│                   平台核心服务层                              │
│  会话引擎 │ 资产引擎 │ 漏洞引擎 │ 事件总线 │ 节点编排         │
│                     平台 Agent                              │
├─────────────────────────────────────────────────────────────┤
│                    节点层（可扩展）                           │
│  渗透测试 Node │ 代码审计 Node │ 应急响应 Node               │
│  日志分析 Node │ CTF Node     │ 情报 Node                   │
└─────────────────────────────────────────────────────────────┘
```

**通信方式**：平台 ↔ 节点之间使用 WebSocket（实时双向）+ REST API（注册/任务/查询）

### 2.2 核心闭环

```
会话创建 → 意图识别/直连入口 → 节点调度(task_assign)
    → 资产探测/漏洞扫描/漏洞验证
    → 实时状态回传 → 对话页展示过程 + 右侧栏同步发现
    → Finding 确认 → 证据/漏洞入库
    → 阶段摘要 + 报告素材生成
```

### 2.3 关键设计原则

1. **平台与节点解耦**：节点独立运行，通过标准协议接入平台
2. **对话为中心**：自然语言驱动所有安全活动
3. **端到端可观测**：工具执行透明展示，关键步骤可干预
4. **数据自然沉淀**：资产/漏洞/证据在 Agent 执行中自动入库并关联
5. **多 Agent 协同**：节点内部 Agent + 技能 + 工具分层架构

---

## 3. 页面设计

### 3.1 Sidebar（全局导航）

不以传统功能模块组织，而是围绕 **"会话"** 组织：

- **顶部「创建会话」按钮**：主入口。点击后**不弹窗**，直接进入空白对话页，用户在输入框中用自然语言描述测试意图。
- **会话列表**：所有会话统一列表，按最后活跃时间倒序排列。不使用分组标签（如"历史会话"）。每项显示 AI 自动生成的标题 + 状态圆点 + 活跃时间。AI 根据用户第一条消息自动命名（如 "Web渗透 — new-platform.example.com"），用户可手动重命名。
- **次级入口**：资产管理、漏洞管理、节点管理、知识库、系统设置
- **状态指示器**：全局在线节点数、活跃会话数、待确认事项、高危漏洞告警

### 3.2 对话页（默认主页/核心工作界面）

用户点击「创建会话」→ 立即进入空白对话页。**不需要先填表单，直接用自然语言描述测试意图。**

```
┌──────────┬──────────────────────────┬────────────────┐
│ Sidebar  │      对话区 (中间)        │  右侧信息面板   │
│          │                          │  [Tab: Agent]  │
│ 会话列表  │  [模板: Web渗透] [主机扫描] │  [Tab: 漏洞]   │
│          │  [权限测试] [复测]        │  [Tab: 资产]   │
│ ▸ 当前会话 │                          │  [Tab: 统计]   │
│          │  用户: "帮我对             │                │
│ 资产     │  https://example.com      │                │
│ 漏洞     │  做渗透测试，有两个账号..."  │                │
│ 节点     │                          │                │
│          │  Agent: 收到，开始预检...  │                │
│          │  Agent: 🔧 nmap 运行中... │                │
│          │  Agent: 🚨 发现 SQL注入   │                │
│          │                          │                │
│          │ ┌──────────────────────┐ │                │
│          │ │ 输入你的测试需求...    │ │                │
│          │ │                  [发送]│ │                │
│          │ └──────────────────────┘ │                │
└──────────┴──────────────────────────┴────────────────┘
```

**输入框**：
- Placeholder: "描述你的测试需求。例如：对 https://example.com 做渗透测试，测试账号 admin/admin123（高权限）和 viewer/viewer123（低权限），重点检查权限提升和 API 鉴权绕过。也可以提供主机 IP 进行网络扫描。"
- 输入框上方提供快捷模板按钮（`button-ghost` pill 样式），点击填入输入框：Web 渗透 / 主机扫描 / 权限测试 / 复测

**会话自动命名**：用户发送第一条消息后，平台 Agent 根据测试意图自动生成会话标题，替换"新会话"。

**对话区消息类型（MVP P0 优先级）**：
- 文本消息（Markdown 渲染）
- 系统通知（节点上线/离线、任务开始/结束）
- 工具调用卡片（工具名称、命令、状态、实时流式输出）
- 漏洞发现卡片（等级、标题、位置、置信度、操作按钮）
- 确认卡片（高风险操作的授权确认）

**右侧信息面板（MVP 仅实现 Tab）**：
- **Agent 状态 Tab**：当前阶段、当前工具、Agent 状态、工具调用历史
- **发现漏洞 Tab**：漏洞列表、等级统计、查看详情、发起报告
- **目标资产 Tab**：目标信息、开放端口、服务版本、资产纳入操作
- **会话统计 Tab**（P2）：运行时间、扫描端口数、工具成功/失败统计

### 3.3 资产管理页

- 资产类型：IP/域名、Web 应用、云服务、代码仓库、日志源、CTF 环境
- 支持按业务系统、资产类型、标签筛选和检索
- 资产详情面板：基本信息 + 属性 + 关联漏洞 + 关联事件 + 历史会话 + 操作日志
- 来源标注：手动添加 / Agent 发现
- 操作：发起扫描、查看详情、编辑、删除、标记重点

### 3.4 漏洞管理页

- 列表展示：漏洞标题、严重等级、CVE 编号、影响资产、发现时间、来源会话、当前状态
- 状态流转：`待确认 → 已确认 → 已报告 → 已修复 → 接受风险`
- 漏洞详情：描述详情、复现步骤、POC、影响 URL/参数、修复建议、状态时间线
- **一键复测**：选择漏洞 → 创建复测会话 → 调用渗透 Agent 重新验证
- 支持按等级/状态/资产/时间范围筛选，支持状态修改、任务指派、报告导出

### 3.5 节点管理页

- 节点列表：名称、节点 ID、类型、健康状态、IP、资源使用率、当前会话数
- 节点注册：生成接入 Token 供节点部署脚本使用
- 节点详情：配置信息、版本、性能指标、当前/历史会话、日志
- 操作：查看详情、重启、配置、禁用、查看日志

---

## 4. Agent 设计

### 4.1 平台 Agent

**定位**：用户与平台之间的默认协同入口，不直接执行安全工具。

**核心能力**：
| 能力域 | 描述 |
|--------|------|
| 意图识别与路由 | 自然语言理解用户安全目标，路由到对应节点 |
| 平台数据操作 | 资产/漏洞的 CRUD 操作 |
| 会话协同 | 补全信息、生成标题、总结摘要、串联上下文 |
| 节点管理 | 查询节点状态、执行摘要、获取日志 |
| 安全知识问答 | 通用漏洞原理、修复建议、威胁情报查询 |

### 4.2 渗透测试 Agent（MVP 核心）

**定位**：一个被平台调度、具备完整安全边界、结构化决策、可追溯证据和漏洞评价能力的 AI 渗透测试工程师。

**内部模块架构**：

```
Task Intake → Policy Engine
     ↓
Runtime Adapter (PydanticAI MVP)
     ↓
Agent Orchestrator + Workflow Engine
     ↓
Policy Engine + Skill/Playbook Engine
     ↓
Tool Gateway → Sandbox Runner
     ↓
Output Parser → Evidence Store → Finding Verifier
     ↓
Platform Sync
```

**执行状态机**：

```
precheck → plan → recon → scan → verify → report
    ↓        ↓       ↓       ↓       ↓        ↓
 blocked  重规划  无攻击面  无漏洞  需授权   任务完成
  failed          completed_no_findings
```

**各阶段说明**：
| 阶段 | 描述 | 成功流转 | 失败/阻断 |
|------|------|---------|-----------|
| precheck | 目标格式/scope/DNS/连通性校验 | → plan | blocked/failed |
| plan | 选 Playbook，生成 TaskPlan | → recon | 等待用户确认 |
| recon | 端口扫描、服务识别、目录枚举 | → scan | completed_no_findings |
| scan | 漏洞扫描、POC、配置检查 | → verify | 无候选Finding |
| verify | 候选Finding复现验证 | → report | 需授权/确认 |
| report | 同步平台、生成摘要和素材 | 任务完成 | — |
| checkpoint | 每阶段写入检查点 | 支持中断恢复 | — |

### 4.3 其他节点 Agent（V2+）

| Agent | 描述 | 计划版本 |
|-------|------|---------|
| 代码审计 Agent | 静态分析发现 CodeFinding，与渗透 Agent 协同动态验证 | V3 |
| 应急响应 Agent | 分析事件、攻击路径、IOC，生成 Incident | V3 |
| CTF Agent | 自动化/半自动化解题，生成 Writeup | V4 |
| 日志分析 Agent | 分析日志异常行为，生成 LogFinding | V5 |

---

## 5. 消息规范

### 5.1 统一消息结构

```json
{
  "msg_id": "msg-001",
  "conversation_id": "conv-001",
  "role": "agent | user | system",
  "msg_type": "text | tool_call | vuln_card | asset_card | confirm_card",
  "content": {},
  "timestamp": "2026-06-25T10:30:00Z",
  "parent_msg_id": null
}
```

### 5.2 消息类型定义

| msg_type | 关键字段 | 说明 |
|----------|---------|------|
| text | text, format | 文本消息，支持 Markdown |
| tool_call | tool_name, command, status, progress, output_stream, start_time, duration_seconds | 工具调用过程展示 |
| vuln_card | vuln_id, title, severity, location, confidence, description, actions_available | 漏洞发现展示 |
| asset_card | asset_id, address, hostname, open_ports, services, is_new, actions_available | 资产发现展示 |
| confirm_card | question, options, context | 需用户选择或确认 |
| auth_card | warning, risk_level, options | 高风险操作授权 |
| step_indicator | steps, current_step | 阶段状态展示 |
| summary_card | hosts_found, ports_open, vulns_by_severity, key_findings | 阶段摘要 |

### 5.3 消息优先级

| 优先级 | 消息类型 | 说明 |
|--------|---------|------|
| **P0** | 文本、系统通知、工具调用、漏洞发现、确认卡片 | MVP 必须实现 |
| **P1** | Agent 摘要、阶段指示器、授权卡片 | 增强透明度与安全 |
| **P2** | 资产卡片、扫描摘要 | 丰富数据呈现 |

---

## 6. 数据模型

### 6.1 核心实体

| 实体 | 核心字段 | 说明 |
|------|---------|------|
| **Asset** | id, name, address, type, tags, group_id, properties(json), source | 统一资产，properties 支持异构扩展 |
| **Vulnerability** | id, title, severity, cvss, cve_id, asset_id, conversation_id, description, poc, remediation, confidence, status | 漏洞记录，可追溯至会话和证据 |
| **Conversation** | id, title, node_id, node_type, platform_agent_id, status, context(json) | 会话容器，context 存中间态 |
| **Message** | id, conversation_id, role, msg_type, content(json), parent_msg_id | 统一消息，content 随 msg_type 变化 |
| **Node** | id, name, type, status, ip, cpu_usage, memory_usage, current_sessions, last_heartbeat | 节点注册与状态 |
| **Event** | id, title, type, severity, asset_id, conversation_id, timeline(json), iocs(json) | 安全事件（应急响应场景） |

### 6.2 节点内部实体

| 实体 | 说明 |
|------|------|
| **ToolRun** | 单次工具执行记录（命令、参数、状态、输出引用） |
| **Evidence** | 结构化证据项（类型、原始引用、摘要、哈希、关联ToolRun） |
| **CandidateFinding** | 候选漏洞（由工具输出解析，需验证确认） |
| **ConfirmedFinding** | 验证确认的漏洞（等级、复现步骤、影响、修复建议） |
| **RetestResult** | 复测结果（漏洞ID、结果、证据、Agent、时间） |

---

## 7. 通信协议

### 7.1 WebSocket 消息类型

**平台 → 节点**：
| 类型 | 说明 |
|------|------|
| task_assign | 下发任务（目标、任务类型、会话ID、scope、策略） |
| user_interrupt | 用户中断指令（暂停/继续/取消/补充参数） |
| user_input | 用户回复（对询问或确认卡片的响应） |
| config_update | 更新节点配置 |

**节点 → 平台**：
| 类型 | 说明 |
|------|------|
| status_update | Agent 状态变化、阶段切换、工具开始/完成 |
| tool_output | 工具实时输出流（stdout/stderr 逐行） |
| vuln_found | 发现漏洞（含证据和置信度） |
| asset_discovered | 新资产或属性更新 |
| request_decision | 向用户请求授权（高风险操作） |
| task_complete | 任务完成（含摘要和报告） |
| task_error | 异常终止信息 |

### 7.2 可靠性保障

- WebSocket 断线自动重连 + 心跳
- 消息队列离线缓存，重连后补传
- 任务指令和结果持久化再发送
- 用户中断通过专用消息通道高优先级处理

---

## 8. 安全控制模型

| 控制项 | 说明 |
|--------|------|
| **Scope Gate** | 每个任务绑定授权范围，工具参数中的 target 必须在 scope 内 |
| **Risk Tier** | 工具风险分4级：observe → safe → intrusive → destructive |
| **Approval Gate** | 高风险动作用确认/授权卡片等待用户许可 |
| **Audit Trail** | 完整记录决策、会话、目标、工具、参数、结果的审计日志 |
| **Kill Switch** | 平台可对会话/工具下发终止指令，节点限定时间内响应 |
| **Evidence Gate** | 漏洞结论必须绑定工具证据和置信度，无证据不形成漏洞记录 |

---

## 9. 技术栈

| 层级 | 推荐方案 | 说明 |
|------|---------|------|
| 平台前端 | React + shadcn/ui + Zustand + TanStack Query + WebSocket | 会话路由、消息渲染、管理页面 |
| 平台后端 | FastAPI (Python) + RabbitMQ | 业务逻辑、API、WebSocket 广播、消息队列 |
| 平台数据库 | PostgreSQL | 核心业务数据存储 |
| 节点主体 | Python FastAPI / asyncio | 平台连接、任务接收、事件回传 |
| Agent Runtime | PydanticAI（MVP） | 工具Schema、结构化输出、HITL |
| LLM 适配 | LiteLLM | 统一接入 OpenAI / Claude / Ollama / 企业私有模型 |
| 沙箱执行 | Docker / Kali Sandbox | 工具隔离执行、资源限制 |
| 节点存储 | SQLite + 文件目录 | 任务记录 + 证据文件 |
| 通信协议 | WebSocket + REST | 实时双向 + 查询/注册 |

---

## 10. MVP 范围

### ✅ 包含
- 平台 Web 对话页（Sidebar + 双栏布局 + 消息卡片 P0）
- 资产管理基础页（列表 + 详情）
- 漏洞管理基础页（列表 + 详情 + 一键复测入口）
- 渗透测试 Node（precheck→recon→scan→verify→report 完整流程）
- WebSocket 实时通信 + REST API
- 用户交互式确认/中断

### ❌ 不含
- CTF、应急响应、日志分析等其他节点类型
- 完整信息面板（P1/P2 消息卡片）
- 多 Agent 编排引擎
- 节点 Web 控制台（MVP 仅 CLI）
- 威胁情报集成
- 用户权限系统 / 多租户
- 报告中心（成果/报告归档）

---

*文档状态：草稿 | 下一步：`/plaid build` 启动 MVP 开发*
