# 产品需求文档 (PRD) — AI 安全运营平台

> **现行产品规格**（与 `AGENTS.md`、`docs/specs/harness.md` 一致）。  
> 最近校准：2026-07-23  
> **Node 路径（已锁）：** 产品核为 **Graph × Pi / Node4 血统**；`node5/` 为 lab 语义参考与退路 B（非对等产品扩）。部署绑定恰好一个 Node 进程（产品默认 Node4）。见 `docs/adr/0001-graph-x-pi-product-path.md`。  

> **Legacy：** `node/` / `node2/` / `node3/` 计划删除，不进入产品能力描述，禁止扩展。  
> **冻结：** `research/`（第三方参照）、`benchmarks/`（lab 评估资产）。  
> **对话 Agent 形态（已落地）：** 平台**不**自带会话 Agent；Node 内置 **`default`（工作台助手）** + 可安装专家包。

---

## 1. 产品定位

平台是以**自然语言会话**为入口的安全测试工作台：

| 部件 | 职责 |
|------|------|
| **平台** | 登录、会话、消息、资产、漏洞、证据、节点注册、授权确认、任务下发/中继与结果展示；**台账 SOT**（数据面，不设对话人格 Agent） |
| **Node（产品绑定运行时）** | 全部用户可见的 Agent 运行时：内置 **`default`**（台账读写 Tools、闲聊与整理；**不**进专家硬 Graph）+ 已安装**专家包**（渗透/CTF 等；专家执行可走 **Hard Graph × Pi**）。产品实现路径为 **`node4/`**；`node5/` 不作默认产品绑定。 |

产品形态：**一个平台（工作台/台账）+ 一个已绑定的 Node（产品路径 Node4 / Graph × Pi）**。  

**不**在平台后端再维护一个与用户对聊的「平台 Agent」；用户始终对着 **Node 上的参与者**（default 或专家）。

---

## 2. 设计原则（产品层）

1. **OMP 类 harness** — 粗粒度 todo 地图 → shell 优先 act → finding+evidence 入账 → **harness/平台结算**；**无 agent finish 工具**。细节见 `docs/specs/harness.md`。
2. **Chat 不是产品真相** — 漏洞/flag 级结论必须经 `finding` + evidence，不能只靠对话文本。
3. **Harness over restriction** — 能力不足时优先改进 prompt / 任务信封 / 工具密度；不把靶场答案表、预期漏洞数、coverage 硬门当作默认「智能」。
4. **结构化意图** — 角色/engagement 来自 UI 或任务信封显式字段；**禁止**用关键词 NLP 扫描用户自然语言猜 workflow。
5. **Node 是唯一 Agent Runtime；Expert 是产品路由实体** — 已绑定的 Node 候选 **始终**带内置 **`default`（工作台助手）**；商业/专项能力以 **专家包** 形式 install；平台 **offers** 许可/计费；**专家管理** 创建可 `@` 的专家实例并绑定 Node。见 `docs/specs/expert-offers.md`。  
   **Model B：** 所有 pack 共享 **platform citizen** 读台账能力 + Scope/资产规则（如 `node4/src/roles/platform-citizen.ts`）；专家再叠加 act 工具与方法论。主机创建仍仅用户授权边界（开测 Authorize / next-scope / 资产页）。
6. **单路径协作** — 用户消息经平台鉴权/落库后转发到所选 Node 参与者；台账读写由 Node 调**平台数据 Tools**完成，避免后端 Agent 与 Node 双脑来回路由。
7. **无靶场答案键** — 不以 DVWA/Juice/CTF flag 列表驱动 runtime 或 prompt。
8. **远程热装 marketplace** — 非本阶段目标。

---

## 3. 用户与核心场景

**主用户：** 安全工程师 / 渗透测试工程师。

**核心故事：**

- 注册在线 Node；在节点管理安装专家包；在专家管理创建专家实例并绑定 Node（多专家可共用同一 Node）。
- **同一会话为共享群聊**：默认与 Node 上的 **工作台助手（`default`）** 对话（查资产/漏洞、整理 finding 状态、解释进度）；需要执行时 **`@专家` / 工具栏选专家** 切换参与者。mention 是点名渠道，不是第二套任务系统。
- 系统按所选参与者落到 Node（default 或专家 pack 的结构化 engagement）；可选 Goal mode（执行向专家）。
- 观察工具过程、证据与已确认 finding；高风险动作可经平台授权卡确认。
- 刷新或重开会话后，消息与结果仍可从平台快照恢复。

---

## 4. 功能范围

### 4.1 平台 Web 工作台

**P0**

- 登录与会话：列表、新建、切换、基本管理。
- 对话页：消息流、工具/状态/漏洞等卡片、working 态；底部统一输入框（多行正文 + Goal 开关 + **参与者**（工作台助手 `default` / 专家）+ 发送/中止），支持 `@专家` 与工具栏选专家。**无「平台 Agent」会话人格。**
- **专家管理**：创建/删除专家实例（name + pack + 绑定 Node）；多专家可共用 Node。
- 节点页：注册、token、在线状态、runtime 预算、**专家包 offers** 安装/卸载（运行时能力层）。
- 资产 / 漏洞列表与详情。
  - **资产所有权（Scope 模型）：** 正式主机行写入仅在 **用户动作** 下发生——资产页人工录入/导入、**开测授权**（主目标不在表时默认登记）、**下一轮 Scope 勾选**、或右侧攻击面 **promote**。**Agent 不得静默新建资产行**（测中旁路只进攻击面候选）。
  - **Agent 可维护的附属信息：** 对已存在主机合并端口、服务指纹、URL、API 端点等表面信息；booking 尽量把 finding 挂到 Scope 主 host（path-only location 回退 task target）；未知主机的 finding 允许暂时 `asset_id` 为空，promote 后可回填。
  - **下一轮 Scope：** 任务结束后若有 out-of-scope 候选 host，UI 多选 → 新任务（新 `scope.allow`），不是同一 work-burst 无限续跑。
- **会话工作态（Send / 中断）：** 以 Node 侧 work-burst（`busy` / `work_status`）为真相源；平台维护会话 `workers` 并广播 `conversation_working`。当前会话只要有专家在工作，UI 显示中断；中断会扇出到该会话全部在线专家运行时。
- 高风险操作：`request_decision` ↔ 用户 authorize/cancel。
- **会话检测报告（按需、可多份）**：用户在对话中说明需要漏洞/检测报告时，工作台助手或专家读取台账已确认 finding，撰写交付 Markdown，经 `platform_create_report` 落库为 Case 的 report revision。顶栏 **报告** 抽屉列出全部版本；每份可选 Markdown/HTML 下载。亦支持 UI「快速合成」仅用台账字段生成草稿（`source=ledger`）。**不**用 NLP 猜 intent；**不**在每次 booking 时自动写报告；**不**发明未 book 的漏洞。
- **计划任务**（`/api/schedules`，结构化 engagement 定时 dispatch，Phase D）。

**P1**

- 右侧面板：Status（Case 级 elapsed / tokens / target、**多角色参与者花名册**、Tasks 带 owner 芯片）、Surface、Findings、Activity——不堆叠重复的 Expert role / Engagement dashboard 卡片。
  - **可见性**：普通对话也可手动打开；**默认折叠**；有任务/目标/工作产物后自动展开。
  - **1 会话 = 1 Case**：`conversation.context.participants` 按 `expert_id`（或 pack+name）记录每位参与者；checkpoint 只更新对应角色，不整表覆盖。
  - **协作树**：每个产品专家 / default 座位一行 root；该角色最近一轮的 subagent 挂在其下；当前 sticky 角色高亮。
  - **Tasks**：todo 投影带 `owner_expert_id/name`；多角色 todo 按 owner 合并展示，不因 handoff 抹掉另一角色清单。
  - **漏洞台账 / 再次发现**：专家与 default 均可 `platform_list_vulnerabilities`；任务 `case_context.findings_summary` 含 Case 资产上的历史 finding。同资产+路径/模块再次 booking → 平台 **rediscover**（保留 `first_seen_at`，`history` 记「再次发现」），不新建重复行；UI 卡片与详情展示 **多次发现** 徽章与发现时间线。
  - **补扫再确认（harness）**：Scope 主机上已有 open prior 时，agent 须把其当作 **re-verify 工作流**（短证明 + `finding(confirm)` 新鲜 proof → rediscovery），与未测面 **穿插**；不得因「台账已有」整表跳过。判断抽样时优先 high/critical；不再复现则 fact/状态更新。见 `experts/pentest/work.md`、`platform-citizen` mission、`case_context` note。
  - **同模块去重身份**：平台 `finding_dedupe` 用 **path 集合相交（含 upload 证据路径别名）+ 标题 stem（去掉 Low/Medium 级别、中英同类头）** 识别同一 finding；安全级别/新绕过不是新行。存量可用 `scripts/repair_finding_ledger.py`。
  - **节点输出语言**：节点详情「配置」可设 `agent_language`：`auto`（跟用户）/ `zh-CN` / `en`。经 `task_assign.worker_limits` 注入 Node4 系统提示，约束**对话回复**与**漏洞台账文案**（标题/描述/PoC 叙述）；工具原始 stdout 不强制翻译。
  - **默认对话角色**：专家管理可勾选「设为默认对话角色」（`experts.is_default`，全站仅一位）。新建会话 / 空白 composer 优先选该专家；未设置时优先 `pack_id=default`，再 online / 列表首位。
  - **诚实计数（harness）**：收尾总结中「重新验证 N」= 本会话成功 `finding(confirm)` 次数，不是 prior 列表长度；「新发现」仅指新台账身份，同 path 合并只能称 rediscovery。见 `experts/pentest/work.md` Honest counts。
- 报告导出 / 导入（现有 sync 能力延续，不阻塞主环）。
- 审计日志中的专家安装、专家实例 CRUD 与 usage billing hook（非真实支付）。
- 历史里程碑与旧计划已删除；运维清理见 **`docs/project-cleanup-plan.md`**。

### 4.2 Node（绑定候选；`docs/specs/harness.md` 以 node4 实现细节为主）

**P0**

- 平台 WebSocket：`task_assign` → 工具事件 / `vuln_found` / evidence → harness `task_complete`（当前产品路径实现见 `node4/`；`node5/` 为对等候选对照臂）。
- Standalone CLI 便于 lab 调试（`node4` standalone；`node5` CLI 对照）。
- **Expert pack** 由 `engagement` / `role` 选择（须已 **install** 到本 Node）；无 engagement 且未装包时跑 **bare runtime**；目录见 `experts/`。
- 工具与循环语义遵循 `docs/specs/harness.md`（todo、shell、fs、http、**session**、**browser**、script、finding、subagent、goal、**skill**；CTF 另有 captcha。均为 **assistive 密度**，非流程关卡）。
- **Pentest Free / Graph：** 不选场景图时为 Free（OMP 自愿 subagent）；显式 `app_assessment` / `redteam_deep`（或 `graph_id`）为 Graph 工作模式（节点菜单 + 软 default_plan + RoE）。见 `docs/specs/task-graph.md`。
- 任务目录可排查：`events.jsonl`、evidence、findings 等。
- **Case 共享 evidence**：`task_assign.case_context` 含 findings + `evidence_snippets`（path/excerpt），供多专家接力（如 pentest 源码泄露 → code-audit）；实现见绑定候选的 booking / harness。

**P1**

- 按真实 lab 审计迭代 pack（session 密度、可选 skill），**不**引入答案键或强制模块覆盖门。
- 浏览器等经 sandbox/环境提供，优先作 act 能力而非流程关卡。

### 4.3 明确非目标（本阶段）

- 将 legacy `node/` / `node2/` / `node3/` 作为产品交付形态；在 PK 前宣布唯一永久 Node 赢家。
- Coverage Store / Phase Controller / Finding Gate 驱动的扫描状态机作为主环。
- Agent 可调用的 `finish_scan` / 终态工具。
- 交互式 TUI 作为 MVP 必达（延后）。
- 真实支付、专家市场、Node↔Node 直连协作网格。
- 用 benchmark case 表注入 prompt 或 runtime gate。

---

## 5. 任务与角色模型

```text
Composer participant: default | @Expert
  → 平台鉴权 + 落库 user message（无对话 Agent）
  → task_assign / user_steer → 绑定 Node
  → Node 解析 seat/pack（default 内置 或 engagement pack；无 NLP）
  → default: 平台数据 Tools + 轻量协助；专家: Map → Act → Book(finding)*
  → harness settle → 平台入库并展示
```

| 字段 / 实体 | 含义 |
|-------------|------|
| **`default`（工作台助手）** | Node 内置 seat；读/整理台账；不 booking；不可当商业专家卸载 |
| Product **Expert** | `@name` 路由实体：绑定 `node_id` + `pack_id` |
| `engagement` / `role` | 结构化 pack id；如 `default`/`consult`、pentest、ctf |
| `goal_mode` / `goal_objective` | 长任务目标锚点（执行向专家）；与参与者选择独立 |
| Node `config.offers` | 节点已安装**专家** pack；`default` 不依赖 offers 安装 |

别名折叠见 offers 文档与绑定候选上的 pack 解析；**不**从 instruction 自由文本推断 engagement。

---

## 6. 验收标准（产品）

1. **闭环**：平台登录 → 在线 Node → 下发授权范围内**专家**任务 → 可见工具过程 → finding/证据可入库与打开详情 → 任务以 harness `task_complete` 结束。
2. **default**：无专家时用户与工作台助手对话；能通过 Tools 读取平台资产/漏洞；不进入失败式 incomplete 闲聊。
3. **角色**：选择 CTF 与 Pentest 产生不同 pack 行为；未安装专家 pack 时执行派发被清晰拒绝（default 仍可用）。
4. **无平台会话 Agent**：用户消息不由后端平台 LLM 人格作答；无硬编码伪造专家台词。
5. **无 finish 工具**：agent 工具列表中不存在结束任务的 finish API。
6. **可恢复**：刷新会话后消息/资产/漏洞/证据仍可从平台恢复。
7. **可排查**：standalone 或节点任务目录保留 events 与证据，供离线 audit。
8. **原则合规**：不出现靶场答案键、不按自然语言 NLP 选 workflow。

Lab（DVWA/Juice 等）仅用于**离线对照与工程调试**，不作为「必须刷满官方 scoreboard」的产品门禁。

---

## 7. 近几步（替代旧长路线图）

1. ~~平台会话 Agent 移除 / Node `default`~~ **done**（ledger Tools + 纯中继）。
2. 渗透 pack：按 OMP 原则用真实 lab events 减样板，少加 gate。
3. 平台 ↔ 绑定 Node 候选 WS 硬化与可观测性。
4. 执行 `docs/project-cleanup-plan.md`（docs 收敛 + legacy 树删除门槛）。
5. Node 路径已锁 Graph × Pi / Node4（ADR 0001）；Node5 仅 lab/退路，不重开 PK 除非 hard triggers。

---

## 8. 文档地图

| 文档 | 用途 |
|------|------|
| `AGENTS.md` | 实现时的硬约束；pre-PK 双候选 |
| `docs/specs/harness.md` | 运行时契约（ primarily `node4/` 实现细节） |
| `docs/specs/task-graph.md` | Free / Graph 工作模式 |
| `docs/specs/expert-offers.md` | 多专家容器 + default 路由 |
| `docs/specs/ctf-role.md` | CTF pack 操作说明 |
| `docs/specs/pen-tools-sandbox.md` | pen-sandbox |
| `docs/v1-delivery.md` | V1 交付边界 |
| `docs/design.md` | UI 视觉与组件 |
| `docs/project-cleanup-plan.md` | 清理执行清单 |
