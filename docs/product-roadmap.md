# 产品路线图：AI 渗透测试 Agent Runtime

> 文档角色：产品和工程路线图的唯一执行入口。  
> 当前校准日期：2026-07-11  
> 当前主线：**Node4** clean-room 简 harness（见 `docs/node4-harness.md`）— 商用自研、不依赖 OMP 源码；平台对接与 Node2 同通道；能力对照 OMP 基线；**TUI 延后**。

## 0. 当前结论

目标是构建面向真实系统的渗透测试 Agent Runtime（商业产品，执行核自研）：

- **Node4 北星**：`docs/node4-harness.md` — Understand → Map(todo) → Act(http/script) → Book(finding) → Close(finish)；无默认 worker/coverage 门禁。
- **Node2**：并行兼容节点；Harness v2 经验见 `docs/harness-v2.md`，不再作为主能力路径堆叠。
- Pi 兼容栈负责 session/tools；**不** vendoring oh-my-pi。
- 平台：会话 / 资产 / 漏洞 / 证据 / 计时；Node 只做执行与事件回写。
- Benchmark / OMP 行为对照衡量能力，不以硬编码答案冒充自治。
- Interactive TUI：预留，本阶段不交付。

下一步优先级：

1. **Node4 standalone runtime + smokes + 三靶场对照**。
2. **Node4 平台 WS 对接**（task_assign → events → task_complete）。
3. 能力硬化（script/sandbox、对照闭环）。
4. TUI（后续）：sticky todo + transcript，与 Web 同语义。
5. Caido / 多身份等旁路增强（不挡主循环）。

## 1. 总体阶段

| 阶段 | 名称 | 状态 | 核心目标 |
|---|---|---:|---|
| Phase 1 | Caido Traffic Truth | 待启动 | 让 browser、http、scanner、verifier 的流量进入统一真相源 |
| Phase 2 | Traffic Analysis + Request-Centric Verifier | 待启动 | 从真实请求建立攻击面地图，并基于 request replay 验证漏洞 |
| Phase 3 | Stateful Attack Orchestration | 待规划 | 支持多账号、多角色、多资源、多步骤业务流程攻击 |
| Phase 4 | Benchmark-Driven Capability Hardening | 待规划 | 用多靶场和真实业务 demo 反向衡量能力缺口 |
| Phase 5 | Skills / PoC / Playbook Knowledge System | 待规划 | 梳理 Skills、PoC Catalog、Playbook 的知识边界 |
| Phase 6 | Tool Execution Runtime & Scanner Integration | 待规划 | 接入真实测试工具，并统一回写 traffic/evidence/finding |
| Phase 7 | Production-Grade Pentest Runtime | 待规划 | 做成可恢复、可审计、可控、可交付的生产级运行时 |

## 2. Phase 1：Caido Traffic Truth

目标：把 Caido 作为 Node2 的统一 traffic source of truth。第一小步先连接外部已启动的 Caido，尽快验证 traffic truth、list/view/repeat、browser/http proxy 和 Node2 evidence/coverage 同步闭环；第二小步对齐 Strix，把 Caido 做成每个 scan 自动启动的 sidecar。

最终形态参考 `research/strix`：

- 每个 scan 创建独立 sandbox / runtime session。
- Caido 作为 session 内 sidecar 自动启动，容器内固定监听端口。
- Runtime 自动注入 `http_proxy`、`https_proxy`、`ALL_PROXY`、`NO_PROXY`。
- Runtime 自动处理 Caido guest token、临时 project 创建和 project select。
- Browser、http、scanner、脚本流量默认经过 Caido。
- Agent 通过 `list_requests`、`view_request`、`repeat_request`、`list_sitemap`、`view_sitemap_entry`、`scope_rules` 操作 Caido。
- Python / script 类工具后续可以导入 Caido helper，用于批量 replay、fuzz 和差异验证。

### 关键任务

- [ ] 增加 Caido runtime / adapter。
  - 支持配置 `CAIDO_URL`、token / PAT，必要时兼容 guest login。
  - 优先验证连接外部已启动 Caido，降低第一阶段复杂度。
- [ ] 增加 Strix-like sidecar lifecycle。
  - 每个 scan / session 自动启动独立 Caido sidecar。
  - 自动暴露 Caido 端口并生成 host-side Caido URL。
  - 自动 `loginAsGuest` 获取 token。
  - 自动创建 temporary project 并 select。
  - 自动清理 session 时关闭 Caido client 和 sidecar。
- [ ] 扩展 ToolRuntime，使工具可访问 Caido adapter。
- [ ] 增加 traffic 工具动作。
  - `list_requests`
  - `view_request`
  - `repeat_request`
  - `list_sitemap`
  - `view_sitemap_entry`
  - `scope_rules`
- [ ] 让 Node2 `http` 工具流量通过 Caido proxy。
- [ ] 让 Playwright browser 流量通过 Caido proxy。
- [ ] 将 Caido 请求、响应、sitemap 同步进 Node2 traffic/evidence/coverage。
- [ ] 明确 proxy、CA、HTTPS、localhost、scope bypass 的处理规则。

### Traffic 主从关系

Caido 是原始流量真相源，Node2 保存同步索引和证据投影。

```ts
Node2TrafficRecord {
  id: string;                 // Node2 本地稳定 id
  source: "caido" | "node2";
  caidoRequestId?: string;
  caidoResponseId?: string;
  caidoReplaySessionId?: string;
  method: string;
  url: string;
  status?: number;
  requestSummary?: object;
  responseSummary?: object;
  rawAvailable: boolean;
  evidenceIds: string[];
}
```

规则：

- Agent 查看和重放原始请求时优先使用 Caido request id。
- Node2 报告、coverage、finding 和 benchmark 中使用 Node2 traffic id 做稳定引用。
- Node2 traffic record 必须能反查 Caido raw request / response。
- 完整 raw request / response 不直接塞进 finding；finding 只引用 traffic/evidence/oracle。
- confirmed finding 必须能关联 baseline traffic、attack traffic 或 replay result、evidence ids 和 oracle result。

### 验收标准

- `http` 工具发出的请求能在 Caido 中被列出和查看。
- browser 登录、表单提交、页面跳转产生的请求能进入 Caido。
- Agent 能基于 Caido request id 查看原始请求和响应。
- Agent 能 replay 一个已捕获请求并修改 URL、header、cookie、body。
- Finding / evidence 可以引用 Caido traffic id 或同步后的 Node2 traffic id。
- Phase 1 结束时，Node2 不只支持外部 Caido，还应具备 Strix-like 自动 sidecar 模式；外部 Caido 只作为开发和调试入口，不作为最终唯一形态。

## 3. Phase 2：Traffic Analysis + Request-Centric Verifier

目标：把流量分析改造成 Agent 的核心测试循环。Agent 先建立目标攻击面地图，再选择真实请求进行 mutation、replay 和验证。

### 目标攻击面地图

Agent 在 recon 后应结构化产出：

- authenticated areas
- endpoints
- forms
- parameters
- state-changing actions
- upload points
- reflected sinks
- stored sinks
- auth/session boundaries
- interesting headers/cookies
- technology fingerprint

Phase 2 第一版不做完整业务对象建模，只冻结 verifier 和 finding 需要的最小攻击面模型：

```ts
EndpointProfile {
  id: string;
  method: string;
  path: string;
  urlExample: string;
  trafficIds: string[];
  authRequired?: boolean;
  contentTypes: string[];
  statusCodes: number[];
  technologies: string[];
  tags: string[];
}

ParameterProfile {
  id: string;
  endpointId: string;
  name: string;
  location: "query" | "body" | "header" | "cookie" | "path";
  valueExamples: string[];
  reflected?: boolean;
  reflectedContexts: string[];
  sourceTrafficIds: string[];
  candidateVulnClasses: string[];
}

ActionProfile {
  id: string;
  endpointId: string;
  kind: "read" | "create" | "update" | "delete" | "login" | "upload" | "unknown";
  stateChanging: boolean;
  csrfTokenNames: string[];
  sourceTrafficIds: string[];
}

SinkProfile {
  id: string;
  endpointId: string;
  parameterId?: string;
  kind: "reflected" | "stored" | "dom" | "file" | "redirect" | "error" | "download";
  context?: string;
  evidenceIds: string[];
  sourceTrafficIds: string[];
}
```

`ActorProfile`、`ResourceProfile`、owner、tenant boundary 和业务对象关系放到 Phase 3。

### 通用 verifier

verifier 不再面向 DVWA 模块，而是面向真实请求：

```ts
verify({
  requestId,
  vulnType,
  mutations,
  oracle
})
```

它应从 traffic store 读取 baseline request，修改 query、body、header、cookie 或 path，再 replay 并基于 oracle 判断结果。

### 关键任务

- [ ] 定义 `EndpointProfile` / `ParameterProfile` / `ActionProfile`。
- [ ] 从 Caido sitemap 和 captured requests 生成 attack surface inventory。
- [ ] 改造 verifier，使其支持 `requestId` 输入。
- [ ] 支持 baseline response 与 attack response 的对比。
- [ ] 支持常见 oracle：
  - 状态码变化
  - 响应长度变化
  - 错误栈 / SQL 错误
  - 反射点
  - 时间差
  - DOM 执行信号
  - 状态变化
- [ ] Finding quality gate 升级。
  - confirmed finding 必须有 baseline request + attack request。
  - confirmed finding 必须能映射到 endpoint / parameter / session。
  - 负面结论不能进入 confirmed finding。

### 验收标准

- Agent 能从真实流量中整理 endpoint、参数、表单和状态变更动作。
- SQLi、XSS、Upload、CSRF、Auth/Session、Access Control 至少能基于 captured request 测试。
- 每个 confirmed finding 都绑定 baseline、attack、oracle 和复现步骤。
- Agent 不依赖 DVWA 路径或固定答案。

## 4. Phase 3：Stateful Attack Orchestration

目标：让 Agent 理解身份、资源、权限边界和业务流程，而不只是对单个请求 fuzz。

### 关键能力

- 多 actor / 多 role / 多 session 管理。
- object id、resource owner、tenant boundary 识别。
- 跨账号 replay。
- 垂直越权、水平越权、IDOR / BOLA 测试。
- CSRF 和 state-changing request 验证。
- 多步骤业务流程的跳步、乱序、重复提交和参数篡改。

### 关键任务

- [ ] 定义 `ActorProfile`。
- [ ] 定义 `ResourceProfile`。
- [ ] 从流量中识别对象 ID、owner 和 CRUD 请求。
- [ ] 支持 actor A 创建资源，actor B replay 访问或修改。
- [ ] 增加 IDOR / Access Control / CSRF / Business Logic playbook。
- [ ] 让 `pi-workflow` 支持前置条件、产物传递、分支、重试和证据绑定。

### 验收标准

- Agent 能用两个账号自动验证 IDOR / 越权。
- Finding 能说明哪个 actor 对哪个 resource 做了不该做的事。
- 多步骤业务流程能被记录、重放、跳步和乱序测试。
- 报告包含两个身份下的 baseline / attack request-response 差异。

## 5. Phase 4：Benchmark-Driven Capability Hardening

目标：用多靶场和真实业务场景衡量迁移能力，避免只围绕 DVWA high 得分优化。

### Benchmark 范围

- DVWA：基础漏洞能力体检。
- Juice Shop：API、JWT、DOM XSS、IDOR、业务逻辑。
- WebGoat：教学型覆盖，适合漏洞族回归。
- PortSwigger Labs 子集：更贴近真实漏洞模式。
- 自建业务 demo：登录、RBAC、订单、上传、API、多账号、状态流。
- API-only benchmark：OpenAPI / Postman collection + auth token。

### 指标

- attack surface coverage
- endpoint coverage
- parameter coverage
- state-changing action coverage
- confirmed finding rate
- false positive rate
- missed expected classes
- total runtime
- request volume
- replay success rate
- evidence quality score

### 关键任务

- [ ] 为每个 benchmark 定义 expected manifest。
- [ ] 区分 confirmed / observed / missed / false positive。
- [ ] 增加 quick / standard / deep 三档 benchmark runner。
- [ ] 输出能力矩阵，而不是只输出总分。
- [ ] 将 missed finding 归因到 workflow、traffic、verifier、skill、tool 或 benchmark harness。

### 验收标准

- 可以一键跑多个 benchmark。
- 每个 expected finding 都能被判定为发现、观察到、漏报或误报。
- 每次能力改动后可以看到能力矩阵变化。
- 不允许为了单个靶场写死特殊路径或 payload。

## 6. Phase 5：Skills / PoC / Playbook Knowledge System

目标：明确知识系统边界，让 Skills、PoC Catalog、Playbook 各司其职。

### 边界

- Skills：方法论、测试策略、注意事项、判断标准。
- PoC Catalog：漏洞族、适用条件、payload、mutation、oracle、证据要求。
- Playbook：可执行测试策略，包括 candidate selector、precondition、mutation、oracle 和 follow-up。
- Runtime state：只存在 traffic、coverage、evidence、finding、workflow state 中。

### 关键任务

- [ ] 迁移到 Pi 原生 Skills，移除旧 skill 工具兼容路径。
- [ ] 建立 Web 漏洞 Skills：
  - SQLi
  - XSS
  - Upload
  - CSRF
  - Auth / Session
  - Access Control
  - Business Logic
  - API Security
- [ ] 建立 PoC Catalog schema。
- [ ] 建立 Playbook schema。
- [ ] Agent 根据目标攻击面动态选择相关 skill / PoC / playbook。

### 验收标准

- Skills 不保存执行状态。
- PoC Catalog 不绑定单个靶场答案。
- Playbook 可以被 workflow 和 verifier 消费。
- 新增漏洞族时，不需要改 Agent 主循环。

## 7. Phase 6：Tool Execution Runtime & Scanner Integration

目标：让 Agent 拥有足够真实的测试执行能力，并让所有工具结果进入统一证据链。

### 工具范围

- browser tool：探索、登录、DOM 交互、前端逻辑触发。
- http / replay tool：基于 captured request 改包重放。
- verifier tool：确认漏洞。
- scanner tool：调用 nuclei、sqlmap、ffuf、nikto、custom scripts 等。
- traffic tool：统一读写 Caido / traffic store。
- artifact tool：保存截图、响应、日志、脚本输出。

### 关键任务

- [ ] 统一工具执行结果 schema。
- [ ] 增加 sandbox、timeout、rate limit、budget 控制。
- [ ] 接入 scanner，但禁止 scanner 绕过 traffic/evidence/finding 链路。
- [ ] 支持批量 replay / fuzz，但需要 scope gate 和风险控制。
- [ ] 支持工具失败归因和可恢复执行。

### 验收标准

- 所有工具动作都有 tool run、traffic、evidence 或 coverage 记录。
- scanner 结果不能直接变成 confirmed finding，必须经过 verifier 或 quality gate。
- 工具执行可以被 workflow budget 和 scope policy 控制。

## 8. Phase 7：Production-Grade Pentest Runtime

目标：把实验型 Agent 变成可恢复、可审计、可控、可交付的生产级 runtime。

### 关键任务

- [ ] 任务恢复：从 workflow state、traffic、coverage、evidence 继续执行。
- [ ] 时间预算：quick / standard / deep 模式稳定运行。
- [ ] 并发控制：多个目标、多个 agent、多个 scanner 不互相污染。
- [ ] session 管理：多账号、多角色、多目标隔离。
- [ ] Hook 管理：Pi hooks 挂载审计、预算、风险控制、报告生成。
- [ ] 安全边界：scope、rate limit、禁止越界请求、敏感操作确认。
- [ ] 报告输出：finding 可复现、证据完整、误报标记清楚。
- [ ] 人工介入：登录、验证码、MFA、业务账号配置。
- [ ] regression：每次改动后跑 quick benchmark。

### 验收标准

- 中断后可以恢复任务。
- 报告中的 confirmed finding 都可复现。
- 所有高风险动作都有 scope 和 approval 记录。
- 能支撑真实授权测试项目的最小交付闭环。

## 9. 和六项原则的对应关系

| 六项原则 | 对应阶段 |
|---|---|
| 通用攻击面工作流 | Phase 2 |
| 统一 traffic truth | Phase 1 |
| 通用可组合 verifier | Phase 2 |
| Evidence 质量裁决 | Phase 2、Phase 7 |
| Skills 做方法论，不做执行状态 | Phase 5 |
| Benchmark 多元化 | Phase 4 |

Phase 3 是在前五项基础上的扩展方向：当 Agent 能看见真实流量、理解请求、验证漏洞并产生可信证据后，再进一步处理身份、资源、状态和业务流程。

## 10. 当前近期执行顺序

短期只推进 Phase 1 和 Phase 2，不提前发散。

1. 实现 Caido adapter，先连接外部已启动 Caido。
2. 让 `http` 工具流量进入 Caido，并能 list/view/repeat。
3. 让 browser 流量进入 Caido。
4. 将 Caido 请求同步到 Node2 traffic/evidence/coverage。
5. 基于 captured request 改造 verifier。
6. 建立 endpoint / parameter / action / sink 攻击面地图。
7. 升级 finding quality gate。

## 11. 历史基线

旧版 roadmap 中的 MVP Alpha、平台模式、Standalone、Export / Import、Demo readiness 等内容已经压缩为历史基线。后续不再用旧乱码任务清单作为执行依据。

历史能力可作为参考：

- 平台会话、消息、资产、漏洞、证据的基础闭环。
- Node standalone 执行和本地持久化。
- Export / Import 结果流转。
- 初版 attack surface、coverage、evidence、finding gate。
- 初版 DVWA / Juice Shop benchmark smoke。

新的执行依据以本文件中的 7 个阶段为准。
