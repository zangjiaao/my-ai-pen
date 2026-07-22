# Node5 — ADK three-layer Graph control arm (CLI only)

**Research / lab对照**，不是产品执行核。产品执行核仍是 **Node4**。

对照问题：渗透专家在 **Task + Agent + Feedback Graph** 组合下 vs Node4 Soft OMP 的表现。

---

## 三层 Graph（唯一产品模型）

| 层 | 组织对象 | Node5 实现 |
|----|----------|------------|
| **Task Graph** | 任务如何执行 | ADK `Workflow` 硬顺序：`app_assessment` `default_plan` |
| **Agent Graph** | 多 Agent 如何协作 | `class_probe` **fan-out workers**（skill package）→ Join |
| **Feedback Graph** | 系统如何持续变好 | `structure` / `tool_use` / `evidence` / **`coverage`** / `retry`；`validate_book` 证据门槛 |

**没有第四 Graph。** 历史上的 Campaign 状态机已拆除；覆盖由 Feedback + `coverage_ledger` 负责。

**State Handoff：** `PenState` 传递 `cookies` / `surfaces` / `candidates` / `coverage_ledger` / `feedback` / `authz_matrix`。

```text
Task Graph (hard):
  START → init → surface → prior_reverify → auth_session
       → class_probe ── Agent Graph fan-out ──┐
       → coverage_probe (deterministic probes; Feedback coverage loop)
       → authz_logic ←────────────────────────┘
       → component → validate_book → finalize

Feedback: after live stages; coverage fails if required surfaces stay untested
```

`python -m node5 describe` 打印 layers JSON。

### Coverage（Feedback 职责）

- `required_coverage(state)`：从 surfaces/resources **派生**应测项（injection / SSRF / graphql / identity / authz / dom / business / ws …）
- `coverage_probe` Task 阶段：确定性探针写 **append-only** `coverage_ledger`
- **两轮队列** + HTTP 预算用尽 → `blocked`（透明，不是 untested 黑洞）
- **禁止**「零 attempt 静默 skipped 当成功」；Feedback `coverage` 环验收
- Agent 提示用 `coverage_hints`（缺口列表）

### 漏洞目录（Main 摘要 → Worker 详情）

两层知识，刻意做薄：

1. **Main/Captain** 提示中注入 `refs/vulns/INDEX.md` 摘要目录（扩召回，不是必挖清单）。
2. **Worker** 按 skill 绑定若干 catalog id，**先 `ref_read vulns/<id>.md` 再测**，回传 candidates。
3. 工具：`ref_list kind=vulns` / `ref_query` / `ref_read`。

条目是通用攻击模式（从常见 write-up 能力谱抽象），**不是**靶场题解。

### 过程质量契约（Feedback，非答案键）

Graph 约束的是「怎么走、有没有测过、能不能装成功」——以及 **过程是否空转**；**不**写死必须挖到哪类洞。

| 契约 | 行为 |
|------|------|
| **structure fail** | `auth_session` 等入 JSON 必需阶段；无 parseable JSON → **有限 1 次** hard retry |
| **discovery empty ready** | `prior_reverify` / `auth_session`：工具已跑（≥8）且 surfaces 够，但 `ready_to_book=0` → soft-fail + **1 次** retry（只要求有证据则入账，不点名洞） |
| **class_probe yield** | fan-out 有 structured workers 且 surfaces 丰富，但 `new_cands` 过低 → `discovery_yield` soft-fail + captain retry |
| **surface 过薄** | API 形应用：appish≥5 + 至少一个 auth/user 路径；object 集合过稀 → salvage + high_value_probe |
| **package force** | `feedback` 与 review/comment 一样强制 `pentest-xss`（避免 top-K 挤掉） |

`summary.process_metrics` 与 `coverage_attempt_rate` **正交**：只看 coverage 不能代表发现力。

### 能力谱深化（相对 Write-Up 类，非挑战通关）

| 步 | 内容 | 状态 |
|----|------|------|
| 1 | Authz 写删矩阵 + coverage 轮转/blocked + SSRF 稳态 | **done** |
| 2 | `dom_client` + browser（不可用 → blocked） | **done** |
| 3 | 身份 reset 后半 + 2FA↔SQLi 信号联动 | **done** |
| 4 | business_logic / websocket + report merge + non-vuln | **done** |
| 5 | 能力类检查表 + Juice live 复评 | **done**（`workspace/juice-v11-depth-*/EVAL.md`） |

**复评检查表（closed / failed(tried) / blocked）：** injection · JWT · SSRF · authz 读/写 · identity · GraphQL · DOM · business · WS · upload · 敏感暴露。

**juice-v11 摘要（proxy EVAL，非通关 KPI）：** attempt_rate **1.0** · close_rate **~0.69** · untested **[]** · authz **write_tried** · SSRF/JWT/injection/ws **closed** · business/graphql **failed(tried)** · browser 环境缺 → **blocked**。

### 严重级别

`summary.findings_by_severity`：critical / high / medium / low / info — 对接平台全级别展示。

---

## vs Node4

| | **Node4**（产品） | **Node5**（本目录） |
|--|-------------------|---------------------|
| Task Graph | Soft scenario graph + ledger | Hard ADK sequential stages |
| Agent Graph | `subagent` packages / batch | class_probe skill workers（CLI） |
| Feedback | harness 提示 / acceptance | 显式 `feedback[]` + coverage + book gate |
| Session | Main jar + promote | CookieJar + actor_cookies |
| Browser | pen-sandbox `browser` | 可选 `browser` 工具（`NODE5_BROWSER`） |
| 接口 | platform + standalone | **仅 CLI** |

---

## 安装

```bash
cd node5
source .venv/bin/activate
uv pip install -e .
```

## Sandbox（默认强制）

Act 工具（`shell` / `http_request` / `browser`）默认在 **pen-sandbox** 容器内执行，与 Node4 L2 对齐。

| 变量 | 含义 |
|------|------|
| `NODE5_SANDBOX` | 默认 `1`（强制）。`0`/`host` = 允许宿主机 |
| `NODE5_ALLOW_HOST_TOOLS=1` | **显式**允许 host fallback（lab 无镜像时） |
| `PEN_SANDBOX_IMAGE` / `NODE5_PEN_SANDBOX_IMAGE` | 镜像，默认 `pen-sandbox:dev` |
| `NODE5_SANDBOX_NETWORK` | 默认 `host`（lab 打 127.0.0.1） |
| `NODE5_DEEP_WORKER_MAX_EVENTS` | deep skill worker event 上限（默认 180） |
| `NODE5_CHAIN_MAX_EVENTS` | identity_chain 每 pass 上限（默认 300） |
| `NODE5_CHAIN_FORCE_CONTINUE_TOOLS` | pass0 tools≥N 且无 S3 时强制 pass1（默认 20） |
| `NODE5_DOM_WORKER_MAX_EVENTS` | xss-dom worker（默认 160） |
| `NODE5_AUTH_SESSION_MAX_EVENTS` | auth_session captain 上限（默认 72，防拖死后半程） |
| `NODE5_BROWSER_SPA_WAIT_MS` | SPA open 后固定 settle 毫秒（默认 3000；不用 networkidle） |
| `NODE5_BROWSER_PROBE` | 默认 `1`：health 探测 sandbox 内 agent-browser |

### 多步身份链 / DOM

- **identity_chain**：`class_probe` 后串行 specialist；**最多 2 pass**。  
  - 续跑触发：半步关键词（`setup 401` / `totp secret` / `chain_stop=S1|S2` 等）**或** pass0 tools≥20 且无 S3（**强制 pass1**，不依赖模型写 chain_stop）。  
  - 每 pass 后 `annotate_identity_half_step` 规范化 notes。  
  - 2FA **优先自建用户** register→login→setup(含 password)→TOTP→verify→whoami；仅 S3 可 book 完整 bypass。  
- **xss-dom worker**：固定 top-8；预算 160。  
- **browser 会话**：`open_text` / `open_eval` / `open_spa` 在**同一** sandbox 进程内 `open → wait(domcontentloaded) → wait(ms) → text|eval`（禁止两次 docker 丢状态）。`text`/`eval` 须带 `url=`。  
- **dom_client**：runtime 不可用 → `blocked: browser_runtime`。

```bash
# 构建镜像（仓库根）
bash sandbox/pen-sandbox/scripts/build.sh
```

Live run 在 sandbox health 失败时 **abort**（除非 dry-run 或 `ALLOW_HOST_TOOLS`）。  
`ref_*` 知识库仍在宿主机只读 pack。

## ADK instruction 注意

Agent 提示放在 **`static_instruction`**（字面 system 文本），**不要**用会走
`inject_session_state` 的 `instruction` 字段。

## 用法

```bash
python -m node5 describe
python -m node5 run --target http://127.0.0.1:8080 --dry-run
python -m node5 run --target http://127.0.0.1:8080 \
  --notes "Authorized lab only." --max-workers 4
```

产物：`workspace/run-<UTC>/`

- `state.json` — PenState（coverage_ledger、feedback、agent_packages）
- `findings.json` — 过 evidence 门槛的 finding
- `summary.json` — `coverage_metrics` + `findings_by_severity` + layers

```bash
cd node5 && .venv/bin/python -m pytest tests/ -q
```

浏览器（可选）：`NODE5_BROWSER=auto|1|0`，`PEN_SANDBOX_IMAGE`。

## 关键模块

| 文件 | 角色 |
|------|------|
| `feedback.py` | evidence + **coverage** 环 |
| `coverage.py` | required_coverage / hints / metrics |
| `coverage_probes.py` | Task 阶段确定性探针 |
| `authz_matrix.py` | dual-actor 矩阵（authz_logic 前置） |
| `packages.py` | Agent fan-out 包选择 |
| `stages.py` / `workflow.py` | Task Graph 节点 |
