# 产品需求文档 (PRD) — AI 安全运营平台

> **现行产品规格**（与 `AGENTS.md`、`docs/specs/harness.md` 一致）。  
> 最近校准：2026-07-23  
> **Node 路径（已锁）：** 产品核为 **Graph × Pi / Node4 血统**（唯一产品 Node 血统）。Fallback B（elevate Node5）已退役；`node5/` 已 hard-delete（ADR 0001 B1 / map #59）。部署绑定恰好一个 Node 进程（Node4）。见 `docs/adr/0001-graph-x-pi-product-path.md`。  

> **Legacy：** `node/` / `node2/` / `node3/` 计划删除，不进入产品能力描述，禁止扩展。  
> **冻结：** `research/`（第三方参照）、`benchmarks/`（lab 评估资产）。  
> **对话 Agent 形态（已落地）：** 平台**不**自带会话 Agent；Node 内置 **`default`（工作台助手）** + 可安装专家包。

---

## 1. 产品定位

平台是以**自然语言会话**为入口的安全测试工作台：

| 部件 | 职责 |
|------|------|
| **平台** | 登录、会话、消息、资产、漏洞、证据、节点注册、授权确认、任务下发/中继与结果展示；**台账 SOT**（数据面，不设对话人格 Agent） |
| **Node（产品绑定运行时）** | 全部用户可见的 Agent 运行时：内置 **`default`**（台账读写 Tools、闲聊与整理；**不**进专家硬 Graph）+ 已安装**专家包**（渗透/CTF 等；专家执行可走 **Hard Graph × Pi**）。产品实现路径为 **`node4/`**（唯一血统）。 |

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

- 登录与会话：列表、新建、切换、基本管理；新建默认标题「新会话」。
- **会话自动命名**（Spec [#457](https://github.com/zangjiaao/my-ai-pen/issues/457)）：默认标题 + 任务信封里已有结构化 target / scope 时，**harness 家政**（瘦 Node Agent，不是参与者 Session）经 `platform_set_conversation_title(only_if_default=true)` 起短标题（侧栏/顶栏即时更新）；无 target 的寒暄/台账闲聊不改名；用户手动改名后不被自动覆盖。专家只在用户明确要求时改名。
- 对话页：消息流、工具/状态/漏洞等卡片、working 态；底部统一输入框（多行正文 + Goal 开关 + **参与者**（工作台助手 `default` / 专家）+ 发送/中止），支持 `@专家` 与工具栏选专家。**无「平台 Agent」会话人格。**
- **专家管理**：创建/删除专家实例（name + pack + 绑定 Node）；多专家可共用 Node。
- 节点页：注册、token、在线状态、runtime 预算、**专家包 offers** 安装/卸载（运行时能力层）。
- 资产 / 漏洞列表与详情。
  - **资产所有权（Scope 模型）：** 正式主机行写入仅在 **用户动作** 下发生——资产页人工录入/导入、**开测授权**（主目标不在表时默认登记）、**下一轮 Scope 勾选**、或从右侧 **Surface / 资产** 路径 **promote**。**Agent 不得静默新建资产行**（测中旁路只进 Case 攻击面候选或 Workset，不写正式 Host）。
  - **Case Surface vs 资产台账：** 右侧 **Surface** tab 的 SoT 是 Case `surface_ledger`（Spec [#368](https://github.com/zangjiaao/my-ai-pen/issues/368)）——**本轮**覆盖。长期资产是 Spec [#454](https://github.com/zangjiaao/my-ai-pen/issues/454) / [`specs/owner-ledger.md`](specs/owner-ledger.md)：**Group × Host × Service 组装**（同一 Host 可进多组、各组口子集不同；别名在 Host 上；vhost 分 Host）。对象冲突以 #368 为准。**#322 Cluster/分身 已退役**，不要再实现。
  - **Agent 可维护的附属信息：** 对已存在 Host 合并端口、指纹、URL；不得静默建 Host / 建 Group / 写组装。booking 尽量把 finding 挂到 Scope 主 host（path-only location 回退 task target）；未知主机的 finding 允许暂时 `asset_id` 为空，promote 后可回填。
  - **下一轮 Scope：** 任务结束后若有 out-of-scope 候选 host，UI 多选 → 新任务（新 `scope.allow`），不是同一 work-burst 无限续跑。
- **会话工作态（Send / 中断）：** 以 Node 侧 work-burst（`busy` / `work_status`）为真相源；平台维护会话 `workers` 并广播 `conversation_working`。当前会话只要有专家在工作，UI 显示中断；中断会扇出到该会话全部在线专家运行时。
- **Session-first 对话路径（Spec [#455](https://github.com/zangjiaao/my-ai-pen/issues/455)）：** 用户与 Participant Session 对话；失败/暂停后的「继续」turn 正文 = 用户原话（或 ChoiceCard 确认文案），target/scope/RoE 走 sticky 结构化字段，**不**把旧 instruction 拼成 engagement book。Task package 仅调度/计时/灯（可 mint 新 `task_id`）；park-hit 只 `prompt(用户原话)`。见 `docs/specs/session-dialogue-path.md`。
- 高风险操作：`request_decision` ↔ 用户 authorize/cancel。
- **会话检测报告（按需、可多份）**：用户在对话中说明需要漏洞/检测报告时，工作台助手或专家读取台账已确认 finding，撰写交付 Markdown，经 `platform_create_report` 落库为 Case 的 report revision。顶栏 **报告** 抽屉列出全部版本；每份可选 Markdown/HTML 下载。亦支持 UI「快速合成」仅用台账字段生成草稿（`source=ledger`）。**不**用 NLP 猜 intent；**不**在每次 booking 时自动写报告；**不**发明未 book 的漏洞。
- **计划任务**（`/api/schedules`，结构化 engagement 定时 dispatch，Phase D）。

**P1**

- 右侧面板：Status（**Case 计量**总 tokens/花费 + **多角色参与者花名册**（行内模型/请求/Token 累计，含 Sub rollup；无工具进度话术）+ Tasks 带 owner 芯片；**不**以 elapsed/起止为主叙事——时间见对话日戳、发送旁活计时、Agent 结果锚点耗时，Spec [#323](https://github.com/zangjiaao/my-ai-pen/issues/323)）、Surface、Findings、Traffic（Case 流量审计：`http`+browser 网络 hook 采集，非 MITM）——不堆叠重复的 Expert role / Engagement dashboard 卡片。
  - **可见性**：普通对话也可手动打开；**默认折叠**；有任务/目标/工作产物后自动展开。
  - **1 会话 = 1 Case**：`conversation.context.participants` 按 `expert_id`（或 pack+name）记录每位参与者；checkpoint 只更新对应角色，不整表覆盖。
  - **协作树**：每个产品专家 / default 座位一行 root；该角色最近一轮的 subagent 挂在其下；当前 sticky 角色高亮。
  - **Tasks**：todo 投影带 `owner_expert_id/name`；多角色 todo 按 owner 合并展示，不因 handoff 抹掉另一角色清单。
  - **漏洞台账 / 再次发现**：专家与 default 均可 `platform_list_vulnerabilities`；任务 `case_context.findings_summary` 含 Case 资产上的历史 finding。同资产+路径/模块再次 booking → 平台 **rediscover**（保留 `first_seen_at`，`history` 记「再次发现」），不新建重复行；UI 卡片与详情展示 **多次发现** 徽章与发现时间线。
  - **先验台账（harness）**：Scope 上已有 finding 时，注入 **按 path/module 折叠** 的标题+一行摘要（×N = 再次发现；按 Scope 端口过滤）。**不是**开场逐条复验作业单。开场先读注入、有活凭据先 `session` 登录；`platform_list_vulnerabilities` 无 port/q 时只回短索引。测到某面再带 port/q 或 `get`。同资产+路径/模块再次 booking → rediscovery。见 `work.md`、`platform-citizen`、`case_context`。 Expert Graph package 复验仍按 harness / task-graph。
  - **同模块去重身份**：平台 `finding_dedupe` 用 **path 集合相交（含 upload 证据路径别名）+ 标题 stem（去掉 Low/Medium 级别、中英同类头）** 识别同一 finding；安全级别/新绕过不是新行。存量可用 `scripts/repair_finding_ledger.py`。
  - **节点输出语言**：节点详情「配置」可设 `agent_language`（可扩展注册表，当前：`auto` 跟随用户 / `zh-CN` 简体 / `zh-TW` 繁體 / `en` / `ja`）。经 `task_assign` / steer 重建时的 `worker_limits.agent_language`，由共享 `formatAgentLanguageInjection` 注入 **所有** Agent Session 系统提示（free OMP、Hard Graph stage、subagent）。**Standing-first（#352）**：系统提示 **以** 英文结构壳 `## Standing node policies` **开头**，其下嵌套 `### Output language (node policy: …)`；本波策略 **正文仍为英文**（后续若 zh-CN 实机思考仍偏英可再开 target-language/双语 body 跟进，不在本波）。约束 **agent 自写叙述**（软保证，非硬翻译过滤）：对话、**Chat 中展示的思考/推理**（与对话同一语言面、非 English-only 旁路）、todo/计划、工具意图/进度叙述、台账字段、阶段/包交接叙述、报告 markdown。模板仅 minimal `{{ language_code }}` / `{{ language_prompt_name }}` / `{{ policy_body }}`（非 full Jinja、无 XML policy 壳）。工具原始 stdout/HTTP body **不翻译**。新增语言 = 扩展 registry 一行（UI/Platform allowlist 同源），不写 per-locale inject 分支。
  - **默认对话角色**：专家管理可勾选「设为默认对话角色」（`experts.is_default`，全站仅一位）。新建会话 / 空白 composer 优先选该专家；未设置时优先 `pack_id=default`，再 online / 列表首位。
  - **诚实计数（harness）**：收尾总结中「重新验证 N」= 本会话成功 `finding(confirm)` 次数，不是 prior 列表长度；「新发现」仅指新台账身份，同 path 合并只能称 rediscovery。见 `experts/pentest/work.md` Honest counts。
  - **Scope Host 薄记忆（`case_context.scope_intel`）**：task_assign 时按结构化 target/scope 解析 Host（非 NLP），注入台账摘要——Host id/地址/端口服务、Scope 端口 prior 计数、按 path/module 折叠的标题+摘要（最多约 24 面）、攻击面 path 草图。**主业仍是拓面与新 finding**。详情按需 `platform_list_vulnerabilities(asset_id, port/q)` / `get`；无过滤 list 只回短索引。
- 报告导出 / 导入（现有 sync 能力延续，不阻塞主环）。
- 审计日志中的专家安装、专家实例 CRUD 与 usage billing hook（非真实支付）。
- 历史里程碑与旧计划已删除；运维清理见 **`docs/project-cleanup-plan.md`**。

### 4.2 Node（绑定候选；`docs/specs/harness.md` 以 node4 实现细节为主）

**P0**

- 平台 WebSocket：`task_assign` → 工具事件 / `vuln_found` / evidence → harness `task_complete`（产品路径实现见 `node4/`）。
- Standalone CLI 便于 lab 调试（`node4` standalone）。
- **Expert pack** 由 `engagement` / `role` 选择（须已 **install** 到本 Node）；无 engagement 且未装包时跑 **bare runtime**；目录见 `experts/`。
- 工具与循环语义遵循 `docs/specs/harness.md`（todo、shell、fs、http、**session**、**browser**、script、finding、subagent、goal、**skill**；CTF 另有 captcha。均为 **assistive 密度**，非流程关卡）。
- **Pentest Default free / Expert Graph：** 无 Graph 模板时为 free OMP；显式 `app_assessment`（产品 Expert Graph）走 Hard Graph runner（阶段 + fail-closed Feedback）。Soft 场景图产品模式已退役（#68 / #76）。见 `docs/specs/task-graph.md`。
- 工作区按 Case / 专家 Session / pi 实例分目录：`workspace/case-{caseId}/`（findings/evidence/surfaces）、`…/expert-{expertId}/`（沙箱 + cookies）、`…/pi-{sessionId}/`（`session.jsonl` 审计 + events；非 Product SOT）。Task 包 id 不再占一层目录。
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
5. Node 路径已锁 Graph × Pi / Node4（ADR 0001 B1）；**Expert 渗透 DoD = Hard Graph × Pi**（成熟 hard 图主路径）；Soft/Default 为轻助理，非 Expert DoD。不重开双核 PK；Exit C 仍为 Runtime 互换退路。

---

## 8. 文档地图

| 文档 | 用途 |
|------|------|
| `AGENTS.md` | 实现时的硬约束；Graph × Pi / Node4 |
| `docs/specs/harness.md` | 运行时契约（`node4/` 实现细节） |
| `docs/specs/task-graph.md` | Free / Graph 工作模式 |
| `docs/specs/expert-offers.md` | 多专家容器 + default 路由 |
| `docs/specs/ctf-role.md` | CTF pack 操作说明 |
| `docs/specs/pen-tools-sandbox.md` | pen-sandbox |
| `docs/v1-delivery.md` | V1 交付边界 |
| `docs/design.md` | UI 视觉与组件 |
| `docs/project-cleanup-plan.md` | 清理执行清单 |
