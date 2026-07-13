# Node4 设计备忘 — 角色化、多 Node、多 Agent 协作预留

> **备忘文档**（非独立实现规格）。  
> 记录日期：2026-07-12  
> 相关：`node4-harness.md`（执行核北星）、`architecture.md`、`product-roadmap.md`、`harness-v2.md`、`Agents.md`。

本文固定近期讨论结论，避免后续对齐 OMP / 扩角色时反复摇摆。

---

## 1. 一句话结论

| 主题 | 结论 |
|------|------|
| 多角色 Agent | **能做**：同一 Node4 harness + 配置/任务信封切角色 |
| 多环境部署 | **能做**：不同环境部署不同 Node，注册到平台 |
| 多 Agent 协作 | **经平台编排**，不是 Node↔Node 直连网格 |
| 现在要不要为大协作改 Node4 | **不必大改**；契约已够用；可选轻量透传字段 |

---

## 2. 角色化（Role Pack）— 以后怎么扩展

共用骨架不变：

```text
Map(todo) → Act(tools) → Book(结构化产物)* → harness continue / settle
```

变的是 **使命 / 工具面 / 入账类型 / 结算标准**，不是重写运行时。

### 2.1 示例角色（产品方向，尚未全部实现）

| 角色 | 使命倾向 | 入账（产品真相） | 工具倾向 |
|------|----------|------------------|----------|
| 常规渗透 / assess | 发现可验证问题 | `finding` + evidence | shell / http / script |
| CTF / challenge | 夺 flag / 解锁 challenge | flag / challenge + evidence | 高密度 shell + script |
| 整改 / remediate | 复现 → 修复 → 回归证明 | fix / retest_result + 前后 evidence | write/edit/shell 验证 |
| 应急 / IR | 定界、时间线、IOC | incident / IOC / timeline + evidence | 默认低破坏、只读优先 |

### 2.2 配置面（Role Pack 应包含）

1. **system prompt**（角色使命，非 coding-agent 默认）  
2. **工具白名单**  
3. **入账 schema / book 工具语义**  
4. **continue / booking 粘合文案**（可共用 backlog 思路）  
5. **结算策略**（何为 completed）  
6. **结构化入口**：`TaskEnvelope.engagement` 或平台显式 `role` — **禁止**用 NLP/关键词扫描用户自然语言猜意图（见 `Agents.md`）

### 2.3 何时拆独立 Node 进程

| 仍用同一 Node4 二进制 + 配置 | 才考虑拆部署单元 |
|------------------------------|------------------|
| 仅 prompt / 工具子集 / 入账不同 | 隔离域/合规硬边界（生产只读 vs 进攻沙箱） |
| 同一平台协议与落盘契约 | 必须独立密钥、审计、网络策略 |

---

## 3. 多环境部署与平台关联

目标形态：

```text
环境 A（靶场/攻防网） ── Node（角色/能力标签） ──┐
环境 B（研发/整改网） ── Node ──────────────────┼── 平台（注册 / 派任务 / 汇总）
环境 C（运营/应急网） ── Node ──────────────────┘
```

| 能力 | 说明 |
|------|------|
| 靠近目标部署 | Node 跑在能触达目标的网络位置 |
| 身份关联 | `NODE_NAME` / `NODE_TOKEN` 等连平台 |
| 任务下发 | 平台 `task_assign`；可选指定 node 或 role 要求 |
| 回写 | 事件 + evidence/finding 元数据进会话真相 |

**诚实状态**：平台已有 nodes / WS 通道概念；**按角色标签的智能调度、成熟流水线**属后续平台工作，不是 Node4 当前阻塞项。

---

## 4. 多 Agent 协作 — 预留原则

### 4.1 正确协作模型（平台中介）

```text
用户/会话
  → 平台拆任务、选 Node、汇总证据/漏洞/资产
  → Node-A 阶段产物入库
  → 平台派 Node-B（可换角色/环境）引用既有 evidence/finding
  → 同一会话视图呈现
```

| 方式 | 态度 |
|------|------|
| 平台中介、任务/阶段/证据引用 | **主路径** |
| 同会话多阶段（先攻后改） | **自然扩展** |
| 多 Node 并行（不同网段） | **适合多环境** |
| Node↔Node 直连 RPC / 私聊 transcript | **非目标**（鉴权、审计、防火墙成本高） |

### 4.2 现在不必做的 Node4 大改

协作接口已经具备：

- `TaskEnvelope`（含可选 `engagement`）  
- WS：`task_assign` → events → `task_complete`  
- 任务目录：`evidence/` / `findings/` / `events.jsonl` / `transcript.jsonl` / manifest  
- harness 独占结算、无 agent finish  

**明确不做（避免假预留）**：

- Node 间直连与通用 multi-agent 总线  
- Node 内嵌复杂 worker 编排（Node2 教训）  
- 为假想角色硬编码工具表 / NLP 路由  

### 4.3 可选极轻量预留（未实现亦可，实现时保持「透传不消费」）

| 项 | 说明 |
|----|------|
| envelope 扩展字段 | 如 `role?`、`parent_task_id?`、`capabilities_hint?` — Node 可先忽略 |
| normalize 透传 | 未知扩展字段不丢 |
| complete/manifest 归因 | 带上 `engagement` / `node_id` 便于平台归因 |
| 节点元数据 | **平台侧** `roles[]` / `capabilities[]` / `network_scope` |

**一句话**：多 Agent = 平台把多个「单 Node、单任务、结构化入账」串起来；Node4 保持该单元清晰即可。

---

## 5. 与 OMP 对齐的既有共识（备忘）

| 项 | 共识 |
|----|------|
| 无 agent finish | 结束由 harness/平台；`finish_scan` 不在 Node4 工具面 |
| todo 状态机 | 与 OMP 同构（content id、单 in_progress、auto-promote） |
| todo 周边 | eager / mid-run nudge / error reminder（无 TUI/markdown 亦可） |
| booking | finding+evidence 为产品真相；booking backlog nudge 防「做了不记」 |
| wall / max-time | **无会话 wall**（与 OMP 默认一致：不设墙钟硬杀）。仅平台/用户取消；自然停 + 有限 continue 结算 |
| shell | 高密度管道；进程组 kill；非 OMP 全量 PTY/snapshot 也可先达标 |
| 评分 | 对照过程与诚实指标；无靶场答案 hardcode |

三靶对照经验（摘要，细节见各 bench 目录）：

- CTF：shell 密度与 flag 集合可接近 OMP  
- DVWA：结构化 finding 入账可强于 OMP 对话过程  
- Juice：干净实例解题可达；须强制/引导 finding 入账；全局 scoreboard 不可当本 run 分数  

---

## 6. 近期工程优先级（备忘）

1. ~~渗透 Role Pack + consult stub~~（已落地 `src/roles/`）  
2. ~~最小 SubagentHost + goal store~~（已落地；Juice 复验见 scratch）  
3. **继续** OMP 过程对齐（bash 会话复用、API error ≠ empty-stop 等）  
4. 平台：节点标签与按 `engagement` 派发；多 Agent 流水线仍平台编排  


---

## 7. 非目标（本备忘范围）

- 现在实现完整 multi-agent 编排器  
- Node 点对点协作协议  
- 按用户自然语言自动选角色（禁止 NLP 意图路由）  
- 为「看起来像多 Agent」硬编码流程表  
