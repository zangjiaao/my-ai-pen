# 产品需求文档 (PRD) — AI 安全运营平台

> **现行产品规格**（与 `AGENTS.md`、`docs/node4-harness.md` 一致）。  
> 最近校准：2026-07-13  
> 执行核：**仅 Node4**。`node/` / `node2/` / `node3/` 仅为历史参照，不进入产品能力描述，未来清理。

---

## 1. 产品定位

平台是以**自然语言会话**为入口的安全测试工作台：

| 部件 | 职责 |
|------|------|
| **平台** | 登录、会话、消息、资产、漏洞、证据、节点注册、授权确认、任务下发与结果展示 |
| **Node（唯一执行核 = Node4）** | 在授权范围内执行渗透/CTF 等角色任务：高密度工具调用、证据与 finding 入账、事件回写 |

产品形态：**一个平台 + 一类可注册的 Node 运行时**（实现仓库为 `node4/`）。不维护多代 Node 产品线。

---

## 2. 设计原则（产品层）

1. **OMP 类 harness** — 粗粒度 todo 地图 → shell 优先 act → finding+evidence 入账 → **harness/平台结算**；**无 agent finish 工具**。细节见 `docs/node4-harness.md`。
2. **Chat 不是产品真相** — 漏洞/flag 级结论必须经 `finding` + evidence，不能只靠对话文本。
3. **Harness over restriction** — 能力不足时优先改进 prompt / 任务信封 / 工具密度；不把靶场答案表、预期漏洞数、coverage 硬门当作默认「智能」。
4. **结构化意图** — 角色/engagement 来自 UI 或任务信封显式字段；**禁止**用关键词 NLP 扫描用户自然语言猜 workflow。
5. **Node 是容器** — 可安装多个专家包（offers）；默认 `pentest`。见 `docs/node-expert-offers.md`。
6. **无靶场答案键** — 不以 DVWA/Juice/CTF flag 列表驱动 runtime 或 prompt。

---

## 3. 用户与核心场景

**主用户：** 安全工程师 / 渗透测试工程师。

**核心故事：**

- 用自然语言描述授权目标与范围，绑定在线 Node，发起任务。
- 显式选择专家角色（如 Pentest / CTF）与可选 Goal mode，而不是系统猜意图。
- 观察工具过程、证据与已确认 finding；高风险动作可经平台授权卡确认。
- 刷新或重开会话后，消息与结果仍可从平台快照恢复。
- 在节点管理中注册 Node、查看 offers、安装/卸载专家包。

---

## 4. 功能范围

### 4.1 平台 Web 工作台

**P0**

- 登录与会话：列表、新建、切换、基本管理。
- 对话页：消息流、工具/状态/漏洞等卡片、working 态。
- 下发任务：目标/范围（可解析）、可选 `@` 指定节点、结构化 **Expert engagement**、可选 **Goal mode / objective**。
- 节点页：注册、token、在线状态、runtime 预算、**专家包 offers** 安装/卸载。
- 资产 / 漏洞列表与详情（来自 Node 回写的结构化事件）。
- 高风险操作：`request_decision` ↔ 用户 authorize/cancel。

**P1**

- 右侧面板：任务/Surface/发现摘要、会话 task 上的专家角色展示。
- 报告导出 / 导入（现有 sync 能力延续，不阻塞主环）。
- 审计日志中的专家安装与 usage billing hook（非真实支付）。

### 4.2 Node（Node4）

**P0**

- 平台 WebSocket：`task_assign` → 工具事件 / `vuln_found` / evidence → harness `task_complete`。
- Standalone CLI（`node4` standalone）便于 lab 调试，同一 harness。
- **Role pack** 由 `engagement` / `role` 选择（默认 pentest；已实现 ctf、consult stub）。
- 工具与循环语义遵循 `docs/node4-harness.md`（todo、shell、fs、http、script、finding、subagent、goal；CTF 等 pack 可扩展 session/browser/skill 等 **assistive** 工具）。
- 任务目录可排查：`events.jsonl`、evidence、findings 等。

**P1**

- 按真实 lab 审计迭代 pack（session 密度、可选 skill），**不**引入答案键或强制模块覆盖门。
- 浏览器等经 sandbox/环境提供，优先作 act 能力而非流程关卡。

### 4.3 明确非目标（本阶段）

- 将 Node2/Node3 或旧 Python `node/` 作为产品交付形态。
- Coverage Store / Phase Controller / Finding Gate 驱动的扫描状态机作为主环。
- Agent 可调用的 `finish_scan` / 终态工具。
- 交互式 TUI 作为 MVP 必达（延后）。
- 真实支付、专家市场、Node↔Node 直连协作网格。
- 用 benchmark case 表注入 prompt 或 runtime gate。

---

## 5. 任务与角色模型

```text
用户消息 / 结构化字段
  → 平台派发 task_assign（target, scope, instruction, engagement?, role?, goal_mode?, goal_objective?）
  → Node 解析 role pack（无 NLP）
  → Map(todo) → Act → Book(finding)* → harness continue / settle
  → 平台入库并展示
```

| 字段 | 含义 |
|------|------|
| `engagement` / `role` | 显式专家/角色；映射 pack（如 pentest、ctf、consult） |
| `goal_mode` / `goal_objective` | 长任务目标锚点；与专家选择独立 |
| Node `config.offers` | 该节点已安装专家；派发前平台可 gate |

别名折叠（如 assess/retest → pentest pack）见 offers 文档与 Node4 `resolveRolePack`；**不**从 instruction 自由文本推断。

---

## 6. 验收标准（产品）

1. **闭环**：平台登录 → 绑定在线 Node → 下发授权范围内任务 → 可见工具过程 → finding/证据可入库与打开详情 → 任务以 harness `task_complete` 结束。
2. **角色**：选择 CTF 与 Pentest 产生不同 pack 行为（工具/使命）；未安装 pack 时派发被清晰拒绝。
3. **无 finish 工具**：agent 工具列表中不存在结束任务的 finish API。
4. **可恢复**：刷新会话后消息/资产/漏洞/证据仍可从平台恢复。
5. **可排查**：standalone 或节点任务目录保留 events 与证据，供离线 audit。
6. **原则合规**：不出现靶场答案键、不按自然语言 NLP 选 workflow。

Lab（DVWA/Juice 等）仅用于**离线对照与工程调试**，不作为「必须刷满官方 scoreboard」的产品门禁。

---

## 7. 近几步（替代旧长路线图）

1. 文档与产品叙事统一为「平台 + Node4」（本 PRD）。
2. 渗透 pack：按 OMP 原则用真实 lab events 减样板（如 session 密度），少加 gate。
3. 平台 ↔ Node4 WS 硬化与可观测性。
4. 历史 `node`/`node2`/`node3` 降级为参照并规划清理。

---

## 8. 文档地图

| 文档 | 用途 |
|------|------|
| `AGENTS.md` | 实现时的硬约束 |
| `docs/node4-harness.md` | Node 运行时北星 |
| `docs/node-expert-offers.md` | 多专家容器 |
| `docs/node4-ctf-role.md` | CTF pack 操作说明 |
| `docs/design.md` | UI 视觉与组件 |
| `docs/archive/` | 过时规格，勿作实现依据 |
