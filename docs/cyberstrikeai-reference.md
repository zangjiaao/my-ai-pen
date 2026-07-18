# CyberStrikeAI 参考清单

**Status:** active — **A–E `[THIS]` done** (2026-07-18); F1/F2 deferred mid-term  
**As of:** 2026-07-18  
**Source:** `research/CyberStrikeAI/`（只改编方法论/产品模式；**不** vendor 代码、**不**替换 Node4 执行核）  
**Precedence:** `AGENTS.md` → `docs/prd.md` → `docs/node4-harness.md` → 本清单（本清单不覆盖 harness 原则）

**标记说明**

| 标记         | 含义                                           |
| ------------ | ---------------------------------------------- |
| **`[THIS]`** | **本次要做**（评估中「较值得考虑」已采纳开做） |
| `[ ]`        | 未做 / 待决策后做                              |
| `[x]`        | 已完成（实现后勾选，并简述落点）               |
| `—`          | **不学不改**（明确排除；勿当作 backlog）       |

架构类（单体 Go、Eino 执行核、vendor 对方运行时）**不收录**；与产品「平台 + Node4 + pack」冲突。

---

## 本次范围（`[THIS]` 一览）

| ID  | 标题                             | 状态 | 落点 |
| --- | -------------------------------- | ---- | ---- |
| A1  | 子代理/专家交接包                | **done** | `node4/src/runtime/subagent-handoff.ts` + `tools/subagent.ts` + harness §6 |
| A2  | 过程事实 vs 正式漏洞分离         | **done** | `fact` tool + `stores/process-fact.ts`；≠ `finding` |
| A3  | 边记边干                         | **done** | `experts/pentest/work.md` + fact/finding guidance |
| A5  | 黑板索引注入                     | **done** | short index inject in `buildSystemPrompt`; `fact(get)` body |
| B1  | HITL 分层策略                    | **done** | `docs/node4-harness.md` HITL tiers |
| B2  | 角色=权限边界，Skill≠权限        | **done** | harness + work.md + skill tool copy |
| C3  | 大工具输出 reduction / 落盘再查  | **done** | `tool-output-governance.ts` + shell tool |
| C5  | 工具清单 → pen-tools checklist   | **done** | `docs/pen-tools-sandbox.md` §7 |
| D3  | 禁止嵌套 task + 委派前目标完整性 | **done** | nest ban + required handoff fields |
| E2  | Skill 渐进式加载                 | **done** | skill list short / load body; prompt + work.md |
| E5  | 从对方 Skill 只抽盲区进 refs     | **done** | `refs/payloads/ssrf.md` protocol notes |
| F1  | Burp 插件形态                    | **deferred mid** | not this batch |
| F2  | 浏览器 DevTools 扩展形态         | **deferred mid** | not this batch |

---

## A. 记忆与协作（过程态）

- [x] **A1** **`[THIS]`** — **子代理/专家交接包**
  - **落点：** `node4/src/runtime/subagent-handoff.ts`（`validateSubagentHandoff` / `formatHandoffPackage`）；`tools/subagent.ts` 必填 `target` `scope` `already_done` `this_turn_goal` `success_criteria`；`docs/node4-harness.md` §6；tests: `subagent-handoff.test.ts`, `cyberstrike-adopted.smoke.ts`.

- [x] **A2** **`[THIS]`** — **过程事实 vs 正式漏洞分离**
  - **落点：** `fact` tool + `ProcessFactStore` under `taskDir/facts/`; never creates host assets; pack toolNames include `fact` (pentest 1.3.2 / ctf / bare).

- [x] **A3** **`[THIS]`** — **边记边干**
  - **落点：** `experts/pentest/work.md` write-as-you-go; fact tool description; process-fact index inject text.

- [ ] **A4** — **事实关系边 / 攻击链图**
  - **后置**（非本次）。

- [x] **A5** **`[THIS]`** — **黑板索引注入**
  - **落点：** `formatProcessFactIndexInjection` + session-runner list at prompt build; bodies via `fact(get)` / `read`.

---

## B. 治理与安全运营

- [x] **B1** **`[THIS]`** — **HITL 分层策略**
  - **落点：** `docs/node4-harness.md` HITL tiers for `request_user_decision` (read-ish free / act in scope / high-risk card; no audit_agent).

- [x] **B2** **`[THIS]`** — **角色 = 权限边界，Skill ≠ 权限**
  - **落点：** harness table; work.md “Skills are methodology, not ACLs”; skill tool description.

- [ ] **B3** — **审计 / 工具执行监控保留** — 后置
- [ ] **B4** — **RBAC / 多用户** — 后置

---

## C. 工具与执行面

- **— C1** — **100+ YAML 一等公民扫描器工具** — **不学**

- [ ] **C2** — **tool_search** — 后置

- [x] **C3** **`[THIS]`** — **大工具输出 reduction / 落盘再查**
  - **落点：** `node4/src/runtime/tool-output-governance.ts`; shell archives under `taskDir/tool-output/`; harness §5; tests: `tool-output-governance.test.ts`, smoke C3.

- [ ] **C4** — **FOFA first-class** — 后置（skill/CLI only）

- [x] **C5** **`[THIS]`** — **工具清单 → pen-tools checklist**
  - **落点：** `docs/pen-tools-sandbox.md` §7 class→CLI table (not harness tools).

---

## D. 多智能体与编排

- **— D1** — Eino 三模式 — **不学**
- [ ] **D2** — 阶段 agent 库 — 后置

- [x] **D3** **`[THIS]`** — **禁止嵌套 + 委派前目标完整性**
  - **落点：** `assertSubagentNestAllowed` + required handoff; `lifecycle.subagentDepth`; harness §6.

- **— D4** — 工作流图 — **不学（近程）**

---

## E. Skill / Role / 知识内容

- **— E1** — 百科 Skill 整包替换 — **不学**

- [x] **E2** **`[THIS]`** — **Skill 渐进式加载**
  - **落点：** `skill` list = id/name/description only; load = body; system prompt + work.md “never bulk-load”.

- **— E3** — 薄 Role YAML 主身份 — **不学**
- **— E4** — RAG 主知识面 — **不学（默认）**

- [x] **E5** **`[THIS]`** — **从对方 Skill 只抽盲区进 refs**
  - **落点：** `experts/pentest/refs/payloads/ssrf.md` (gopher/dict/cloud metadata notes); CHANGELOG 1.3.2; `experts/RESEARCH-SOURCES.md`.

---

## F. 产品外围

- [ ] **F1** **`[THIS · 中期]`** — **Burp 插件形态** — **deferred** (this batch)
- [ ] **F2** **`[THIS · 中期]`** — **浏览器 DevTools 扩展** — **deferred** (this batch)
- **— F3–F5** — C2 / WebShell / 机器人 — **不学**
- [ ] **F6–F8** — 批量任务 / 资产运营大全 / vision — 后置

---

## 明确排除（汇总）

| ID       | 原因                                              |
| -------- | ------------------------------------------------- |
| C1       | 破坏 shell-first / 工具面膨胀                     |
| D1       | 不引入 Eino 三模式产品                            |
| D4       | 近程不做工作流图主环                              |
| E1       | 不整包替换 thick skills                           |
| E3       | 不用薄 Role 替代 pack                             |
| E4       | 默认不做主知识 RAG                                |
| F3 F4    | C2 / WebShell 非主路径                            |
| F5       | 近程不做机器人                                    |
| （架构） | 单体运行时 / Eino 核 / vendor 代码 — 本清单不收录 |

---

## 验证入口

```bash
cd node4
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"   # if needed
npm run test:cyberstrike   # handoff + facts + output gov + tool smoke
npm run smoke              # full node4 smoke
```

---

## 相关文档

- [`prd.md`](prd.md) — 平台 + Node4
- [`node4-harness.md`](node4-harness.md) — OMP harness（handoff / facts / HITL / output gov）
- [`pentest-next-steps.md`](pentest-next-steps.md) — lab / OSINT 后置
- [`pen-tools-sandbox.md`](pen-tools-sandbox.md) — L2 + CyberStrike class checklist
- [`../experts/RESEARCH-SOURCES.md`](../experts/RESEARCH-SOURCES.md)
- 源码参考树：`research/CyberStrikeAI/`（只读）
