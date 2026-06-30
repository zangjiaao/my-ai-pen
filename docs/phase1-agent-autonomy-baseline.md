# Phase 1 Agent 自治能力基线设计

> 文档角色：MVP Demo Phase 1 的专项技术设计。`docs/product-roadmap.md` 仍是唯一执行计划和 checkbox 来源；本文件用于解释 Phase 1 为什么这样做、参考哪些项目、具体怎么落地。
> 最近校准：2026-07-01

## 1. 目标

Phase 1 的目标不是让 Agent 会调用更多工具，而是让渗透 Agent 形成可验证的最小自治闭环：

- 能从真实目标中提取攻击面，而不是只依赖用户描述或聊天上下文。
- 能记录每个端点、参数、漏洞类型的测试覆盖，避免重复测试和漏测。
- 能根据阶段目标和覆盖状态选择下一步，而不是在错误 phase 中反复调用失败工具。
- 能把候选漏洞转化为有证据链的 confirmed finding。
- 能在 DVWA/Juice Shop 上输出可量化的自治验收结果，而不是只跑预设脚本。

## 2. 非目标

Phase 1 不做以下内容：

- 不做多节点调度、任务队列、RabbitMQ ACK。
- 不做完整知识库/长期记忆/子代理并行。
- 不做完整 TUI；TUI 属于后续 standalone 阶段。
- 不做泛化到所有漏洞类型；MVP 先覆盖 Web 演示必需项。
- 不把 DVWA/Juice Shop runbook 当成自治能力证明。runbook 只是 benchmark harness。

## 3. 参考项目价值排序

### 3.1 PentesterFlow-agent：主参考

最值得直接借鉴的点：

- `CoverageStore`：记录 `(endpoint, parameter, vulnClass)` 的状态，支持 `mark/list/untested/summary`。
- `confirm_finding`：明确要求复现后的真实请求、响应证据、影响和修复建议。
- `AgentEvent`：Agent loop 通过事件输出，UI/TUI/log 只是 event sink。
- permission bridge：工具授权与 UI 解耦。
- session/debug log：适合我们后续排查 Agent 行为。

Phase 1 采用方式：

- Coverage Store 的数据模型和 `untested()` 思路直接移植到 Python。
- confirmed finding 的字段要求参考 `confirm_finding`，但落到我们已有 `vuln_found/evidence_created` 事件和平台漏洞表。
- event sink 思路放到 Phase 3 统一 runtime，但 Phase 1 的事件字段先按这个方向设计。

### 3.2 AIRecon：主参考

最值得直接借鉴的点：

- `AttackSurfaceTracker`：对 endpoint 记录已测漏洞类型和尝试次数，并注入提示避免重复。
- soft pipeline：RECON -> ANALYSIS -> EXPLOIT -> REPORT，每阶段有目标、推荐工具和自动转移条件，但不是简单硬阻断。
- validators：报告必须绑定 runtime replay evidence，拒绝推测性报告。
- Textual TUI 和 SQLite memory 对后续阶段有参考价值。

Phase 1 采用方式：

- Attack Surface Inventory 比 AIRecon 的 tracker 更结构化，记录 host、URL、method、form、param、service、source evidence。
- Phase Controller 采用 soft gate：错误工具调用转为 observation 和下一步建议，而不是重复 fail。
- Finding Quality Gate 参考 validators，要求复现请求、响应证据、目标 URL、payload/参数、影响。

### 3.3 PentestGPT：阶段控制参考

最值得借鉴的点：

- stage definition 把系统提示、任务提示、prior results 分开。
- Pentest pipeline 先 Asset Identification，再 Vulnerability Identification，再 Report。
- BFS Vulnerability Identification 的思想适合“先覆盖再深入”。

Phase 1 采用方式：

- 我们不照搬它的独立 stage backend；只借鉴 phase definition 和 prior context 注入。
- `analysis/verify` 阶段应优先 coverage breadth，再允许对高价值候选深入验证。

### 3.4 HexStrike-AI-fork：安全门禁参考

最值得借鉴的点：

- ScopeValidator：CIDR、hostname、wildcard、regex。
- BlastRadius：safe、intrusive、destructive。
- TargetRateLimiter：每目标并发和 RPS 控制。
- KillSwitch：按 session 终止进程。
- AuditLogger：安全决策进入审计和报告 methodology。

Phase 1 采用方式：

- 现阶段不重写全部 guardrails，但 verifier 和工具执行必须输出 risk/tier 信息。
- Phase 2/3 可把 blast radius 和 audit trail 纳入平台/standalone 一致授权。

### 3.5 Claude-Red：漏洞类型与测试方法参考

最值得借鉴的点：

- Web 技能覆盖 SQLi、XSS、SSRF、SSTI、XXE、IDOR、file upload、RCE、deserialization、request smuggling、open redirect、parameter pollution、GraphQL、business logic。
- MINDMAP 能作为 coverage taxonomy 的起点。

Phase 1 采用方式：

- MVP verifier 先选 SQLi、XSS、Auth/session、IDOR/access control、Sensitive information。
- 后续扩展漏洞类型时，以 Claude-Red/OWASP WSTG 分类扩展 coverage `vuln_type`。

### 3.6 pentestagent：辅助参考

最值得借鉴的点：

- playbook 把 Discovery/Exploitation 的 objective 和 technique 列出来。
- notes tool 有 finding、credential、vulnerability、artifact 等结构化字段。
- Textual TUI 和多代理可作为后续参考。

Phase 1 采用方式：

- 可参考 `thp3_web.py` 设计初始 Web 测试 checklist。
- notes schema 的字段可辅助 Attack Surface 和 Evidence 的 metadata 设计。

## 4. 目标架构

```text
Agent Loop
  -> Intake
  -> Attack Surface Inventory
  -> Coverage Store
  -> Phase Controller
  -> Tool Execution / Browser / HTTP
  -> Verifier Pipeline
  -> Evidence Store
  -> Finding Quality Gate
  -> Platform Events / Checkpoint
```

核心原则：

- Attack Surface 是“测什么”的事实源。
- Coverage 是“测过什么”的事实源。
- Evidence 是“凭什么相信”的事实源。
- Finding Quality Gate 是“能不能成为漏洞”的门槛。
- Phase Controller 是“下一步做什么”的控制器。

## 5. 数据结构

### 5.1 AttackSurfaceItem

```python
@dataclass
class AttackSurfaceItem:
    surface_id: str
    conversation_id: str
    kind: Literal["host", "url", "form", "api_endpoint", "service", "port"]
    url: str | None
    address: str | None
    method: str | None
    parameters: list[str]
    auth_context: str | None
    technology_hints: list[str]
    source_tool_run_id: str | None
    evidence_ids: list[str]
    metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime
```

最低要求：

- 同一个 URL + method + normalized parameters 去重。
- 来源必须可追踪到 tool_run 或 evidence。
- 可以先存在 checkpoint/context 中，后续 standalone 再落 SQLite；平台导入阶段再决定是否建表。

### 5.2 CoverageEntry

```python
@dataclass
class CoverageEntry:
    coverage_id: str
    conversation_id: str
    endpoint: str
    parameter: str
    vuln_type: str
    status: Literal["tried", "passed", "failed", "skipped"]
    count: int
    notes: str | None
    evidence_ids: list[str]
    first_seen: datetime
    last_seen: datetime
```

状态语义：

- `tried`：执行过有意义测试，但结果尚未确认。
- `passed`：测试完成，未发现漏洞。
- `failed`：发现可疑或确认问题，需绑定 evidence。
- `skipped`：由于 scope、auth、风险、重复或前置条件缺失而跳过。

### 5.3 CandidateFinding

```python
@dataclass
class CandidateFinding:
    candidate_id: str
    title: str
    vuln_type: str
    target_url: str
    method: str | None
    parameter: str | None
    payload: str | None
    evidence_ids: list[str]
    confidence: Literal["low", "medium", "high"]
    status: Literal["candidate", "confirmed", "rejected"]
    reason: str | None
```

Candidate 不等于 Vulnerability。只有通过 Finding Quality Gate 后才能进入 confirmed vulnerability。

## 6. Phase Controller

Phase 顺序：

```text
intake -> recon -> analysis -> verify -> report -> complete
```

### intake

目标：确认 target、scope、可达性、协议、host.docker.internal/localhost 映射。

退出条件：

- target 可解析或明确不可达。
- scope 已建立。
- 有初始 Asset。

### recon

目标：建立 Attack Surface Inventory。

退出条件：

- 至少发现一个可测试 endpoint/form/service，或明确目标不可测试。
- attack surface 有来源 evidence。

### analysis

目标：根据 attack surface 和 coverage 选择测试计划。

退出条件：

- 生成未覆盖测试项列表。
- 至少选择一个 verifier 或明确跳过理由。

### verify

目标：运行 verifier，把候选结果转成 evidence 和 candidate finding。

退出条件：

- coverage 被 mark。
- candidate finding 被创建或该测试项 passed/skipped。

### report

目标：对 confirmed findings 和 no-finding coverage 生成总结。

退出条件：

- 所有 confirmed finding 通过 Finding Quality Gate。
- 输出 coverage summary。

### complete

目标：停止任务，保存 checkpoint，向平台发送 task_complete。

## 7. Verifier Pipeline

MVP verifier 列表：

- `sqli_basic`：基于响应差异、错误特征、时间延迟的最小 SQLi 验证。
- `xss_reflection`：检测 payload 是否进入 HTML/JS/attribute 上下文，先做 reflected XSS。
- `auth_session`：检查默认凭据、弱会话标志、登录状态变化和未授权访问。
- `idor_access_control`：检测对象 ID 参数、跨用户访问、未授权读取。
- `sensitive_info`：检测 `.env`、备份文件、目录列表、错误堆栈、密钥模式。

统一输入：

```python
@dataclass
class VerifierInput:
    surface: AttackSurfaceItem
    vuln_type: str
    session_context: dict[str, Any]
    scope: Scope
```

统一输出：

```python
@dataclass
class VerifierResult:
    status: Literal["passed", "failed", "skipped"]
    evidence_ids: list[str]
    candidate: CandidateFinding | None
    coverage_notes: str
```

## 8. Finding Quality Gate

confirmed finding 必须满足：

- `title`、`vuln_type`、`severity`、`target_url`。
- 至少一个 evidence_id。
- 复现请求或 curl。
- 响应证据或可观察影响。
- 影响说明。
- 修复建议。
- 与 scope 匹配。

拒绝条件：

- 只来自扫描器标题，没有复现证据。
- 只写“可能存在”“建议进一步确认”。
- evidence 目标和 finding 目标不一致。
- payload、参数、响应片段无法对应。
- 越权目标或未授权高风险动作。

## 9. Agent Prompt 注入

每轮 LLM 调用前注入紧凑上下文：

```text
Current phase: verify
Target/scope: ...
Attack surface summary:
- GET /login.php params=[] source=http_request evidence=e1
- POST /login.php params=[username,password] source=browser evidence=e2
Coverage summary:
- sqli: 2 tried, 1 passed, 1 failed
- xss: 1 untested
Next untested candidates:
- POST /login.php username xss
- POST /login.php password sqli
Finding gate reminder:
- Do not confirm without evidence_ids + reproduction request + response proof.
```

注入原则：

- 不把完整工具输出塞进 prompt，只塞 evidence 摘要和引用。
- 明确告诉 Agent 不要重复 coverage 已 passed 的项。
- 如果用户说“继续”，默认从 checkpoint 的 phase/coverage 继续，而不是重新 precheck。

## 10. 事件与持久化

Phase 1 至少需要以下事件稳定：

- `attack_surface_discovered`
- `coverage_marked`
- `candidate_finding_created`
- `finding_rejected`
- `vuln_found`
- `evidence_created`
- `checkpoint_update`
- `task_error`
- `task_complete`

事件要求：

- 都必须带 `conversation_id`。
- 工具相关事件必须带 `tool_run_id`。
- 可恢复 UI 不能从前端临时状态推导，应由后端 snapshot 或 checkpoint 恢复。

## 11. TASK 映射

| Roadmap Task | 本文件落点 | 主参考 |
|---|---|---|
| TASK-008 Attack Surface Inventory | 第 5.1 节、第 6 节 recon | AIRecon、PentestGPT、pentestagent |
| TASK-009 Coverage Store | 第 5.2 节、第 9 节 | PentesterFlow、AIRecon |
| TASK-010 Phase Controller | 第 6 节 | AIRecon、PentestGPT |
| TASK-011 Finding Quality Gate | 第 5.3 节、第 8 节 | PentesterFlow、AIRecon |
| TASK-012 Web verifier | 第 7 节 | Claude-Red、PentesterFlow |
| TASK-013 Autonomy smoke | 第 12 节 | PentesterFlow、AIRecon |

## 12. 验收与 smoke

`scripts/agent_autonomy_smoke.py` 应输出：

```json
{
  "target": "http://host.docker.internal:8080/login.php",
  "session_id": "...",
  "attack_surface_count": 0,
  "coverage_total": 0,
  "coverage_by_status": {
    "tried": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0
  },
  "confirmed_findings": 0,
  "candidate_findings": 0,
  "rejected_findings": 0,
  "evidence_count": 0,
  "duplicate_actions": 0,
  "manual_approvals": 0,
  "false_positive_suspected": 0
}
```

最低通过标准：

- 刷新/恢复后 attack surface、coverage、evidence、findings 数量不变化。
- 对同一目标执行“继续”不会重新丢到 intake，除非用户明确要求重头开始。
- confirmed finding 全部有 evidence_ids 和复现链路。
- 对不可达目标能输出可解释失败，不生成漏洞。
- 对 DVWA/Juice Shop 至少能完成攻击面发现和 coverage 记录；漏洞数量以证据为准，不强行要求固定数字。

## 13. 实现顺序建议

1. 先实现内存态 Attack Surface 和 Coverage，并写入 checkpoint。
2. 接入 HTTP/browser 工具输出解析，生成 attack surface。
3. 在 Agent prompt 中注入 coverage summary 和 untested candidates。
4. 重排 phase controller，去掉重复硬失败。
5. 实现 CandidateFinding 和 Finding Quality Gate。
6. 实现最小 verifier。
7. 做 autonomy smoke，并用 DVWA/Juice Shop 记录真实表现。

这个顺序能先解决“Agent 不知道测过什么”的根问题，再解决“发现能不能确认”的质量问题。

## 14. 主要风险

- LLM 仍可能绕过 verifier 直接总结漏洞：用 Finding Quality Gate 拦截。
- coverage 过细导致上下文膨胀：只注入摘要和未测 top candidates。
- browser/http 解析不稳定：先支持 HTML forms、links、URL query params，再扩 API schema。
- DVWA 安全等级、登录态等环境差异会影响结果：smoke 需要记录环境前置状态。
- 如果只做平台内存态，后续 standalone 会返工：数据结构按 SQLite 表设计，但 Phase 1 可先落 checkpoint。
