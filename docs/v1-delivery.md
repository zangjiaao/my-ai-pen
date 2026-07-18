# V1 小交付范围（试点）

> 校准：2026-07-19  
> 目标：**可控试用 / 私有化小交付**，工程师主导授权范围内的 AI 辅助测试 + 台账管理。  
> **不是**全自动红队、不保证漏洞覆盖率。

---

## 1. 产品定位（对外话术）

| 是 | 不是 |
|----|------|
| AI **辅助**安全测试工作台 | 无人值守全自动渗透 |
| 会话驱动 Agent 执行 + 证据入账 | 传统扫描器替代品 |
| 漏洞台账 / 报告 / 状态看板 | 企业级多租户 SOC |
| 可选定时复测 / 巡检 | 承诺「找全所有漏洞」 |

**主入口：Agent 会话。** 状态看板（Dashboard）在侧栏供透视全局状态，不替代对话。

---

## 2. V1 包含

| 域 | 能力 |
|----|------|
| **会话 / Agent** | 登录 → 在线 Node → default 助手 / `@专家` → 工具过程 → finding+evidence → harness 结算 |
| **台账** | 资产（用户建主机）、漏洞生命周期、证据、多版本报告 MD/HTML |
| **状态看板** | 全局 KPI / 严重级别 / 近期 finding（侧栏入口，非默认首页） |
| **定时任务** | 结构化 engagement 周期派工（UI + 现有 schedules API） |
| **品牌与登录** | Logo / favicon；登录页左宣传 + 右表单；对话右栏轻入场动效 |
| **运行时** | Node4 + experts packs + pen-sandbox（shell/browser） |
| **文档** | 安装边界、已知限制、RoE 提示 |

---

## 3. V1 明确不做

- Goal 机制深挖 / 开放目标 maximize 完成闸门  
- 多租户企业 RBAC、Jira/工单深度集成  
- 专家市场、真实支付  
- Coverage 状态机 / answer key  
- 完整 K8s 生产编排（先 compose 私有化）  
- 重型营销站 / 视频登录背景  

---

## 4. 产品代码边界（发布包）

| 维护并发布 | 参照不发布 |
|------------|------------|
| `platform/` | `node/` `node2/` `node3/` |
| `node4/` | `research/` |
| `experts/` | 本地 `node4/workspace/`、lab session dumps |
| `sandbox/`（pen-sandbox 说明/镜像） | |

Spec 权威：`AGENTS.md` → `docs/prd.md` → `docs/node4-harness.md`。

---

## 5. 推荐安装形态（试点）

```text
1. platform: docker compose（db + rabbitmq + backend）+ frontend dev/build
2. node4: 本机或同机进程，配置平台 WS + 模型 API Key
3. pen-sandbox 镜像（shell/browser）；见 docs/pen-tools-sandbox.md
4. 节点管理安装专家包（如 pentest）；专家管理创建实例并绑定 Node
5. 用户创建资产（主机）→ 会话中 @专家 → 授权范围测试
```

**生产前必改：** `JWT_SECRET`、数据库口令、模型密钥、Node token；勿用 lab 默认值。

---

## 6. 已知限制（须告知用户）

1. **发现质量波动** — 模型与目标相关；需人工复核 finding。  
2. **生产风险** — 主动测试可能影响业务；须书面授权与范围。  
3. **主机资产** — Agent 不新建 IP/域名行；用户先建资产。  
4. **开放目标无「测完」标准** — 不以官方 scoreboard 为 SLA。  
5. **定时任务** — 复测/巡检定位，非无人挖洞。  
6. **费用** — LLM token 与长任务时长需客户自行监控。  

---

## 7. 验收清单（够用就发）

- [ ] 登录 → 默认进入 **会话**（Agent 主入口）  
- [ ] 侧栏可打开 **状态看板**，数字来自台账  
- [ ] 在线 Node + 专家包 → 对白名单目标执行 → finding 入漏洞页  
- [ ] 证据可打开；报告可下载  
- [ ] 可中断任务；高风险可授权卡  
- [ ] 定时计划可创建/启停（若 worker 可用则可见 last fire）  
- [ ] Logo / 登录分栏可用；右栏入场不卡消息流  
- [ ] 本文档与 compose/env 示例可按步骤起环境  

---

## 8. 后续（用户反馈后）

- Harness 工程化发现节奏（攻击面枚举，非 Goal）  
- 漏洞流程加深（复测闭环、指派）  
- 部署硬化（CI/CD、无 reload 生产 compose）  
