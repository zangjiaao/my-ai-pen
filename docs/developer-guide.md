# 开发者上手指南

> 阅读顺序：先读完 `prd.md` 和 `architecture.md`，然后看本文档开始编码。

---

## 1. 项目结构

```
my-ai-pen/
├── platform/                    # 平台 (FastAPI + React)
│   ├── backend/
│   │   ├── app/
│   │   │   ├── main.py          # FastAPI 入口
│   │   │   ├── config.py        # 配置 (env/DB/RabbitMQ)
│   │   │   ├── api/
│   │   │   │   ├── auth.py      # 认证端点
│   │   │   │   ├── conversations.py
│   │   │   │   ├── assets.py
│   │   │   │   ├── vulnerabilities.py
│   │   │   │   ├── nodes.py
│   │   │   │   ├── skills.py
│   │   │   │   ├── knowledge.py
│   │   │   │   ├── memories.py
│   │   │   │   └── sync.py      # 离线报告导入
│   │   │   ├── ws/
│   │   │   │   ├── router.py    # WebSocket 路由 (按 conversation_id)
│   │   │   │   └── messages.py  # 消息类型定义
│   │   │   ├── models/          # SQLAlchemy/Pydantic 模型
│   │   │   ├── services/        # 业务逻辑
│   │   │   ├── middleware/
│   │   │   │   └── auth.py      # JWT 中间件
│   │   │   └── db/
│   │   │       ├── migrations/  # Alembic 迁移
│   │   │       └── seed.py      # 初始数据
│   │   └── requirements.txt
│   ├── frontend/
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── pages/
│   │   │   │   ├── ConversationPage.tsx
│   │   │   │   ├── AssetPage.tsx
│   │   │   │   ├── VulnerabilityPage.tsx
│   │   │   │   ├── NodePage.tsx
│   │   │   │   ├── SkillPage.tsx
│   │   │   │   ├── KnowledgePage.tsx
│   │   │   │   └── MemoryPage.tsx
│   │   │   ├── components/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── TopBar.tsx
│   │   │   │   ├── ConversationPanel.tsx
│   │   │   │   ├── MessageRenderer.tsx  # msg_type → 卡片分发
│   │   │   │   ├── cards/
│   │   │   │   │   ├── ToolCallCard.tsx
│   │   │   │   │   ├── VulnCard.tsx
│   │   │   │   │   ├── ConfirmCard.tsx
│   │   │   │   │   ├── AssetCard.tsx
│   │   │   │   │   ├── ThinkingCard.tsx
│   │   │   │   │   ├── AttackChainCard.tsx
│   │   │   │   │   └── ScoreboardCard.tsx
│   │   │   │   ├── RightPanel.tsx
│   │   │   │   ├── FileViewer.tsx    # 只读文件查看 Tab
│   │   │   │   ├── SonnerToast.tsx
│   │   │   │   └── CreateSessionDialog.tsx  # 实际不弹窗,直接进对话页
│   │   │   ├── stores/
│   │   │   │   ├── authStore.ts      # Zustand
│   │   │   │   ├── conversationStore.ts
│   │   │   │   └── messageBuffer.ts  # conversation_id → Message[]
│   │   │   ├── hooks/
│   │   │   │   ├── useWebSocket.ts
│   │   │   │   └── useApi.ts         # TanStack Query hooks
│   │   │   └── lib/
│   │   │       ├── api.ts            # REST client
│   │   │       └── types.ts          # 共享类型
│   │   └── package.json
│   └── docker-compose.yml            # 平台 + PostgreSQL + RabbitMQ
│
├── node/                          # 渗透 Node (Python)
│   ├── pentest_node/
│   │   ├── main.py                 # CLI 入口 (platform/standalone 模式)
│   │   ├── config.py
│   │   ├── agent/
│   │   │   ├── loop.py             # PentestAgentLoop
│   │   │   ├── state.py            # AgentState, Phase
│   │   │   ├── supervision.py      # SupervisionEngine + AgentHooks
│   │   │   └── prompts.py          # 系统提示词 (4层)
│   │   ├── tools/
│   │   │   ├── registry.py
│   │   │   ├── execute.py          # Docker 沙箱执行
│   │   │   ├── browser.py          # Playwright
│   │   │   ├── http.py             # http_request (限速感知)
│   │   │   └── workflow.py         # phase_transition, confirm_finding 等
│   │   ├── sandbox/
│   │   │   ├── docker.py           # DockerSandbox + DockerSandboxEnv
│   │   │   └── local.py            # LocalEnv (开发用)
│   │   ├── analysis/
│   │   │   ├── traffic.py          # TrafficAnalyzer
│   │   │   ├── waf.py              # WAFDetector
│   │   │   └── diff.py             # ResponseDiffEngine
│   │   ├── evidence/
│   │   │   ├── store.py            # EvidenceStore
│   │   │   └── verifier.py         # FindingVerifier
│   │   ├── auth/
│   │   │   └── manager.py          # AuthManager (多账号)
│   │   ├── skills/
│   │   │   └── loader.py           # SkillEngine
│   │   ├── memory/
│   │   │   ├── coverage.py         # CoverageStore
│   │   │   └── app_model.py        # ApplicationModel
│   │   ├── platform/
│   │   │   ├── ws_client.py        # WebSocket 客户端
│   │   │   └── sync.py             # PlatformSync
│   │   └── tui/
│   │       └── app.py              # Textual TUI
│   ├── skills/                     # 10 个内置 Skill 文件
│   ├── Dockerfile
│   ├── Dockerfile.sandbox          # pentest-sandbox 镜像
│   └── requirements.txt
│
├── docs/                           # 设计文档
└── vision.json
```

---

## 2. 数据库 DDL

### 2.1 平台 PostgreSQL

```sql
-- 用户 (JWT 认证)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,              -- NULL if OAuth
    oauth_provider TEXT,             -- 'google', 'github', NULL
    oauth_subject TEXT,              -- OAuth subject ID
    display_name TEXT,
    org_id UUID,                     -- 预留 V5 多租户
    role TEXT DEFAULT 'member',      -- 'admin', 'member' (V5 扩展)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 会话
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT DEFAULT '新会话',
    user_id UUID REFERENCES users(id),
    node_id UUID REFERENCES nodes(id),
    platform_agent_id TEXT,
    status TEXT DEFAULT 'created',   -- created|running|paused|completed|failed
    context JSONB DEFAULT '{}',      -- execution_plan, discovered_assets, vulns_list, agent_state, scope
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_conversations_user ON conversations(user_id, last_active_at DESC);

-- 消息
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,              -- 'user' | 'agent' | 'system'
    msg_type TEXT NOT NULL,          -- text|tool_call|vuln_card|asset_card|confirm_card|thinking_card|attack_chain_card|scoreboard_card
    content JSONB NOT NULL,          -- msg_type 决定 content 结构
    parent_msg_id UUID REFERENCES messages(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- 资产
CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    type TEXT NOT NULL,              -- host|web_app|cloud_service|code_repo|log_source
    tags TEXT[] DEFAULT '{}',
    group_id UUID,
    properties JSONB DEFAULT '{}',   -- 类型特定扩展
    source TEXT DEFAULT 'manual',    -- 'manual' | 'agent_discovered'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_assets_type ON assets(type);

-- 漏洞
CREATE TABLE vulnerabilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    severity TEXT NOT NULL,          -- critical|high|medium|low|info
    cvss REAL,
    cve_id TEXT,
    asset_id UUID REFERENCES assets(id),
    conversation_id UUID REFERENCES conversations(id),
    description TEXT,
    poc TEXT,
    remediation TEXT,
    confidence TEXT DEFAULT 'medium', -- high|medium|low
    status TEXT DEFAULT 'pending',    -- pending|confirmed|reported|fixed|accepted|false_positive
    evidence_ids TEXT[] DEFAULT '{}',
    discovered_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_vulnerabilities_severity ON vulnerabilities(severity, status);

-- 节点
CREATE TABLE nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    type TEXT DEFAULT 'pentest',
    status TEXT DEFAULT 'offline',    -- online|offline|busy
    token_hash TEXT,                  -- 注册 Token SHA256
    ip INET,
    cpu_usage REAL,
    memory_usage REAL,
    current_sessions INT DEFAULT 0,
    last_heartbeat TIMESTAMPTZ,
    config JSONB DEFAULT '{}',
    registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- 审计日志
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_type TEXT NOT NULL,         -- user|agent|node|system
    actor_id UUID NOT NULL,
    actor_name TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,               -- session|vulnerability|asset|node|conversation
    resource_id UUID,
    detail JSONB,
    ip_address INET,
    user_agent TEXT,
    conversation_id UUID,
    status TEXT NOT NULL              -- success|failure|denied
);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_type, actor_id);
```

### 2.2 节点 SQLite

```sql
CREATE TABLE node_tasks (id TEXT PRIMARY KEY, conversation_id TEXT, target JSON, scope JSON, policy JSON, status TEXT, created_at REAL, updated_at REAL);
CREATE TABLE tool_runs (id TEXT PRIMARY KEY, task_id TEXT, tool_name TEXT, command TEXT, risk_level TEXT, exit_code INT, stdout_ref TEXT, stderr_ref TEXT, start_time REAL, end_time REAL);
CREATE TABLE findings (id TEXT PRIMARY KEY, task_id TEXT, title TEXT, vuln_type TEXT, severity TEXT, affected_asset TEXT, location TEXT, confidence REAL, status TEXT, evidence_ids TEXT, created_at REAL);
CREATE TABLE checkpoints (iteration INT PRIMARY KEY, phase TEXT, phase_iteration INT, timestamp REAL, snapshot JSON);
CREATE TABLE coverage (endpoint_pattern TEXT, param_name TEXT, vuln_type TEXT, tested_at REAL, result TEXT, PRIMARY KEY(endpoint_pattern, param_name, vuln_type));
```

---

## 3. REST API 端点

### 3.1 认证

| 方法 | 路径 | 请求 | 响应 | 说明 |
|------|------|------|------|------|
| POST | `/api/auth/login` | `{email, password}` | `{access_token, refresh_token, user}` | JWT 签发，有效期 24h |
| POST | `/api/auth/refresh` | `{refresh_token}` | `{access_token, refresh_token}` | 刷新 Token |
| POST | `/api/auth/logout` | — | `204` | 服务端标记 refresh_token 失效 |
| GET | `/api/auth/me` | — | `{id, email, display_name, role}` | 当前用户信息 |
| POST | `/api/auth/oauth/{provider}` | `{code}` | `{access_token, refresh_token, user}` | Google/GitHub OAuth |

**JWT Payload**: `{sub: user_id, email, role, org_id, exp, iat}`

### 3.2 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/conversations` | 创建会话。Body: `{node_id?}` → 自动分配可用 Node。返回 `{id, title, status}` |
| GET | `/api/conversations` | 列表。Query: `?status=active&limit=50&offset=0`。返回 `{items:[], total}` |
| GET | `/api/conversations/{id}` | 详情。返回完整 conversation 含 context |
| GET | `/api/conversations/{id}/messages` | 消息列表。Query: `?after={msg_id}&limit=100` |
| PATCH | `/api/conversations/{id}` | 更新。Body: `{title?, status?}`。status 只能: paused / resumed |
| POST | `/api/conversations/{id}/steer` | 发送纠偏消息。Body: `{text}`。转发到 Node steering_queue |
| DELETE | `/api/conversations/{id}` | 软删除 (status=archived) |

### 3.3 资产

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/assets` | 列表。Query: `?type=&tags=&search=&limit=&offset=` |
| POST | `/api/assets` | 创建。Body: `{name, address, type, tags?, properties?}` |
| GET | `/api/assets/{id}` | 详情（含关联漏洞、历史会话） |
| PATCH | `/api/assets/{id}` | 更新 |
| DELETE | `/api/assets/{id}` | 删除 |

### 3.4 漏洞

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vulnerabilities` | 列表。Query: `?severity=&status=&asset_id=&limit=&offset=` |
| GET | `/api/vulnerabilities/{id}` | 详情（含 POC、证据、修复建议） |
| PATCH | `/api/vulnerabilities/{id}` | 更新。Body: `{status?, severity?, remediation?}` |
| POST | `/api/vulnerabilities/{id}/retest` | 创建复测会话。返回 `{conversation_id}` |

### 3.5 节点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/nodes` | 列表（含状态、资源使用率） |
| POST | `/api/nodes` | 注册节点。Body: `{name, type}`。返回 `{id, token}` |
| GET | `/api/nodes/{id}` | 详情 |
| PATCH | `/api/nodes/{id}` | 更新配置 |
| DELETE | `/api/nodes/{id}` | 删除（撤销 Token） |

### 3.6 同步 (离线报告导入)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/sync/import` | 上传 report.tar.gz。Body: multipart/form-data。返回 `{conversation_id, assets_imported, vulns_imported}` |

### 3.7 Skill / 知识库 / 记忆

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/skills` | Skill 列表 |
| POST | `/api/skills` | 上传自定义 Skill (multipart .md) |
| GET | `/api/skills/{name}` | Skill 详情 (Markdown 内容) |
| PATCH | `/api/skills/{name}` | 启用/禁用 |
| DELETE | `/api/skills/{name}` | 删除自定义 Skill |
| GET | `/api/knowledge/search` | 搜索。Query: `?q=&limit=5` |
| POST | `/api/knowledge` | 添加知识条目 |
| GET | `/api/memories` | 记忆列表 |
| POST | `/api/memories` | 添加记忆 |
| PATCH | `/api/memories/{id}` | 编辑记忆 |
| DELETE | `/api/memories/{id}` | 删除记忆 |

### 3.8 通用错误格式

```json
{"error": {"code": "NOT_FOUND", "message": "Conversation not found", "detail": {}}}
```

错误码: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR`, `NODE_OFFLINE`, `RATE_LIMITED`

---

## 4. WebSocket 消息 Schema

单条 WS 连接，按 `conversation_id` 路由。认证：连接时带 `?token={jwt}`。

### 4.1 平台 → 节点

```json
// 下发任务
{"type": "task_assign", "conversation_id": "uuid", "task_id": "uuid",
 "node_type": "pentest", "target": {"type": "host|url", "value": "..."},
 "scope": {"allow": ["*.example.com"], "deny": []},
 "policy": {"max_risk": "intrusive", "approval_required": ["destructive"]},
 "credentials": [{"username": "admin", "password": "***", "role": "high_privilege"},
                 {"username": "viewer", "password": "***", "role": "low_privilege"}],
 "initial_instruction": null}

// Steer 纠偏
{"type": "user_steer", "conversation_id": "uuid", "text": "不要扫 22 端口"}

// 中断
{"type": "user_interrupt", "conversation_id": "uuid", "action": "pause|resume|cancel"}

// 用户回复（确认卡片）
{"type": "user_input", "conversation_id": "uuid", "request_id": "uuid",
 "response": "authorize|cancel", "notes": null}

// 配置更新
{"type": "config_update", "conversation_id": "uuid",
 "changes": {"scope": {"allow": ["*.example.com", "api.example.com"]}}}
```

### 4.2 节点 → 平台

```json
// 状态更新
{"type": "status_update", "conversation_id": "uuid", "task_id": "uuid",
 "phase": "recon", "iteration": 12, "status": "running",
 "active_tool": "nmap", "progress": {"iteration": 12, "max": 50}}

// 工具输出 (流式)
{"type": "tool_output", "conversation_id": "uuid", "task_id": "uuid",
 "tool_run_id": "uuid", "tool_name": "nmap",
 "stream": "stdout", "line": "80/tcp open http", "timestamp": "..."}

// 漏洞发现
{"type": "vuln_found", "conversation_id": "uuid", "task_id": "uuid",
 "finding_id": "uuid", "title": "SQL 注入", "severity": "high",
 "confidence": "high", "affected_asset": "192.168.1.100",
 "location": "/api/users?id=", "evidence_ids": ["ev-001", "ev-002"],
 "reproduction": "...", "remediation": "..."}

// 资产发现
{"type": "asset_discovered", "conversation_id": "uuid", "task_id": "uuid",
 "address": "10.0.1.10", "asset_type": "host",
 "open_ports": [22, 80, 443, 3306],
 "services": [{"port": 80, "name": "http", "version": "nginx 1.24"}],
 "is_new": true}

// 请求授权
{"type": "request_decision", "conversation_id": "uuid", "task_id": "uuid",
 "request_id": "uuid", "risk_level": "destructive",
 "question": "是否允许 sqlmap 执行 --dbs 命令？",
 "proposed_action": "sqlmap -u ... --dbs --batch",
 "target": "/api/users?id=1", "expires_at": "2026-06-28T15:05:00Z"}

// 任务完成
{"type": "task_complete", "conversation_id": "uuid", "task_id": "uuid",
 "status": "completed|completed_no_findings|failed|cancelled",
 "summary": {"assets_found": 6, "vulns_confirmed": 3, "false_positives": 1,
             "duration_seconds": 2847, "phases_completed": ["recon","scan","verify","report"]}}

// 任务错误
{"type": "task_error", "conversation_id": "uuid", "task_id": "uuid",
 "error_code": "TARGET_UNREACHABLE|SCOPE_DENIED|TOOL_MISSING|NETWORK_ERROR|LLM_ERROR|SANDBOX_ERROR",
 "message": "...", "detail": {}}

// 阶段转换
{"type": "phase_changed", "conversation_id": "uuid", "task_id": "uuid",
 "from": "recon", "to": "scan", "summary": "发现 6 个资产, 23 个端点"}
```

---

## 5. 前端组件树与关键 Props

### 5.1 页面路由

```
/                          → ConversationPage (默认)
/assets                    → AssetPage
/vulnerabilities           → VulnerabilityPage
/nodes                     → NodePage
/skills                    → SkillPage
/knowledge                 → KnowledgePage
/memories                  → MemoryPage
```

### 5.2 ConversationPage 组件树

```tsx
<ConversationPage>
  <Sidebar
    conversations={Conversation[]}
    activeId={string}
    onCreateSession={() => void}
    onSelectSession={(id) => void}
    pendingCounts={{}}           // conversation_id → pending_count
  />
  <ConversationPanel
    conversationId={string}
    messages={Message[]}
    onSendSteer={(text) => void}
  >
    <TemplateChips onSelect={(template) => void} />
    <MessageRenderer message={Message}>
      {/* 根据 msg_type 分发: TextBubble | ToolCallCard | VulnCard | ConfirmCard | 
         AssetCard | ThinkingCard | AttackChainCard | ScoreboardCard | SystemNotice */}
    </MessageRenderer>
    <ChatInput onSend={(text) => void} placeholder="..." />
  </ConversationPanel>
  <RightPanel
    conversationId={string}
    findings={Finding[]}
    progress={ProgressInfo}
    pendingApprovals={Approval[]}
    files={FileInfo[]}
    onFindingsClick={(id) => void}   // 打开 VulnDetailDialog
    onApprovalClick={(id) => void}   // 滚动到确认卡片
    onFileClick={(path) => void}     // 打开 FileViewer Tab
  />
  <FileViewer                     // 只读文件查看
    open={boolean}
    filePath={string}
    content={string}
    language={string}             // 自动检测代码高亮
    onClose={() => void}
  />
  <VulnDetailDialog               // 漏洞详情弹窗
    open={boolean}
    finding={FindingDetail}
    onClose={() => void}
  />
  <SonnerToast                    // 全局通知
    notifications={Notification[]}
    onAction={(id) => void}
  />
</ConversationPage>
```

### 5.3 Zustand Store 核心 Shape

```ts
// messageBuffer.ts — 多会话消息缓冲
interface MessageBuffer {
  buffers: Record<string, Message[]>;  // conversation_id → messages
  append(conversationId: string, msg: Message): void;
  getMessages(conversationId: string): Message[];
}

// conversationStore.ts
interface ConversationStore {
  conversations: Conversation[];
  activeId: string | null;
  pendingCounts: Record<string, number>;  // 待确认数
  setActive(id: string): void;
  updateStatus(id: string, status: string): void;
}
```

### 5.4 WebSocket Hook

```ts
function useWebSocket(token: string) {
  const { buffers, append } = useMessageBuffer();
  
  // 单连接，按 conversation_id 路由消息到对应 buffer
  // 重连策略: 指数退避 1s→2s→4s→8s→max 30s
  // 心跳: 每 30s ping，60s 无 pong→重连
}
```

---

## 6. 开发顺序建议

| 阶段 | 内容 | 产出 |
|------|------|------|
| 1 | 平台后端骨架 + 数据库迁移 + JWT 认证 | `POST /api/auth/login` 可用 |
| 2 | 平台前端骨架 + 路由 + Sidebar + 登录页 | 能看到空对话页 |
| 3 | WebSocket 基础设施 (连接/心跳/消息路由) | 平台-Node 能通信 |
| 4 | Node 骨架 + Docker 沙箱 + execute 工具 | Node 能接收任务并执行命令 |
| 5 | Agent Loop (precheck→recon→scan→verify→report) | 第一个渗透任务跑通 |
| 6 | 浏览器自动化 + 认证管理 + 流量分析 | Web 应用测试能力就绪 |
| 7 | 全量消息卡片 + 右侧面板 4 Tab | 完整 UI 体验 |
| 8 | 独立模式 CLI + TUI + 离线导出 | Node 可脱离平台运行 |
| 9 | 审计 + 记忆 + 知识库 | 平台智能增强 |
| 10 | 多节点管理 + 子代理 | 演示级完整体验 |

---

*本指南是编码入口。详细业务逻辑见 `pentest-node-spec.md`，UI 规范见 `design.md`，架构见 `architecture.md`。*
