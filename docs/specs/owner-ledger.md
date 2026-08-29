# Spec: Owner ledger (Group × Host × Service assembly)

**Status:** Living Spec — **locked model**. **#454a / #454b / #454c shipped**; product Asset UI + Agent inventory path **ready for acceptance** (batch/select/identity/group tools). Intel is not this Spec.  
**Tracker:** [#454](https://github.com/zangjiaao/my-ai-pen/issues/454)  
**Supersedes:** [#322](https://github.com/zangjiaao/my-ai-pen/issues/322) and implementation tickets [#340](https://github.com/zangjiaao/my-ai-pen/issues/340)–[#345](https://github.com/zangjiaao/my-ai-pen/issues/345). Do **not** amend or revive `docs/specs/asset-inventory.md` (deleted with the #322 revert).  
**Related:** Case Surface [`case-surface-ledger.md`](case-surface-ledger.md) / [#368](https://github.com/zangjiaao/my-ai-pen/issues/368); NEW precipitation [#410](https://github.com/zangjiaao/my-ai-pen/issues/410) / [`surface-new-tested-coverage.md`](surface-new-tested-coverage.md); product-state UI [#280](https://github.com/zangjiaao/my-ai-pen/issues/280); finding identity [#275](https://github.com/zangjiaao/my-ai-pen/issues/275).

**Product path:** Platform owner ledger on Node4 Graph × Pi (ADR 0001). Not a new Node kernel.

**Does not reintroduce:** Soft product mode; dual-kernel; Service cluster / 分身; Host-level cluster; path-as-Service; Surface tab as inventory tree; Agent silent Host create from recon; keyword intent routing.

**Object conflicts:** Case Surface / this-Case NEW·TESTED / origin+path identity → **#368 / #410 win**. This Spec must not redefine them. Durable paths under a Service are a **later attach** on this ledger, not a second Case Surface.

**Glossary:** `CONTEXT.md` § Owner ledger. This file is the product contract.

---

## Problem Statement

1. Operators think in **公司 / 系统 / 项目**, then machines, then ports — not a flat Host table and not a Service-first card dump.
2. One Host often participates in **more than one Group with different ports** (商城用 `:80/:443`，OA 用同一 IP 的 `:8080`). A Host-only folder always drags every port.
3. Domain + public IP + internal IP that the owner treats as **one machine** are aliases on one Host. Distinct vhosts that share an IP are **distinct Hosts** — attack surface is `host:port`, so they must not merge.
4. #322 answered (2) with a Service cluster (分身 across Hosts). That object is the wrong grain: it fights aliases, fights vhost separation, and the UI never found a honest create path. **#322 is retired**, not patched.

---

## Solution

```text
Group「XXX公司」
  Host 1.1.1.1            tags: 部门1
    Service :80/http      tags: 系统1
    Service :443/https    tags: 系统2
  Host 2.2.2.2            tags: 系统2, 部门2
    Service :1143/tcp

Group「XXX系统1」
  Host 1.1.1.1            tags: 应用服务器
    Service :80
    Service :443

Group「XXX系统2」
  Host 1.1.1.1            tags: 应用服务器
    Service :8080
  Host 2.2.2.2            tags: 数据库服务器
    Service :1443
```

Same Host `1.1.1.1` in two Groups with **different Service subsets**. That is assembly, not two Host rows.

### Identity

| # | Lock |
|---|------|
| **Group** | User-owned named bucket. No required kind. Independent of Host and Service. |
| **Host** | Owner-enrolled machine card keyed by **asset id** (not bare address). Primary IP **or** domain + optional **aliases** (same machine only). **Same address string may exist as multiple Hosts** when they belong to different units (Group-scoped collision). Ungrouped also allows multiple cards with the same IP if ids differ. |
| **Service** | That Host + one port. Proto/name are display. No Service without a Host. Same IP two ports = two Services. |
| **Assembly** | Explicit user relation: **Group + Host + a chosen subset of that Host’s Services**. Empty port subset = bare Host in that Group (show the Host, no ports). |
| **Tag** | Label on a **Host** or a **Service**. Not required to assemble, book, or admit. |
| **Service 攻击面** | Durable paths under a Service (company book). Enter only from `finding(confirm)` or an **accepted HTTP(S) Traffic settle** on an **existing** Host. Scan / SYN does not. Do not create a Host to hang a path. |
| **Finding** | Stays `asset_id` + `port` (existing law / #275). Service is the face those two already name. No cluster merge. No new Finding PK. |
| **Intel** | Durable clues on **Host / Service** (v1). Law: [`owner-intel.md`](owner-intel.md) / map [#459](https://github.com/zangjiaao/my-ai-pen/issues/459). Group hang deferred. |

### Aliases vs vhosts (do not collapse)

| Case | Object |
|------|--------|
| `1.1.1.1` with children `example.com`, `10.0.0.1` | **One Host**, aliases. Agent: same machine. |
| `a.example.com:443`, `b.example.com:443`, `10.1.1.1:443` | **Three Hosts**. Even if DNS says one IP, surfaces stay apart. |

Do **not** auto-merge a vhost into an IP Host. Do **not** invent a Service cluster that links `shop.example.com:443` to `203.0.113.10:443`.

### Writes

| # | Lock |
|---|------|
| **Host** | User create / authorize-register / promote, **or Agent `platform_create_asset` when the user explicitly asked** (reason required; CIDR ≤256/call), **or Case asset-intake `enroll_group`** (user-asked policy; harness creates into that Group). **Merge only when the address is already a member of the target Group**; otherwise always create a new Host (cross-unit same IP stays two cards). Agent enrich: `platform_enrich_asset` / **`platform_batch_enrich_assets`**. Never invent Hosts from recon alone. `platform_assemble_group` ports = Group **view subset** only. |
| **Service row** | User adds a port on a Host, **or** book / accepted HTTP(S) settle names that `host:port` on an existing Host. nmap-sized dumps do not become Service rows. |
| **Group** | User create / rename / delete. Agent does **not** create Groups. |
| **Assembly** | User puts a Host into a Group and picks which Services belong there. Adding a Host to a Group does **not** imply every port. Removing the last Service from an assembly leaves a bare Host in the Group or removes the Host from the Group (UI: user chooses). |
| **Tags** | User (and Agent, non-`sys`) on Host or Service. Editing a tag does **not** create or extend a Group. |
| **Path onto Service 攻击面** | Book or accepted HTTP(S) settle only. Wave 2 — do not block Wave 1 tree on path persist. |
| **Scope** | Still **host-based**. Assembly / Group membership does **not** auto-expand `scope.allow` for *other* members. User-authorized Host **ids** (decision card, 资产页开测, Workset adopt, or this-Case enroll_group of *that* discovery) become this Case Scope. Harness then projects intel; Agent continues the original task. |

### Reads / search

Search is **condition AND**. The operator is searching **Hosts**; Groups are section headers; Services are the children that survive the filter.

| Hit | Show |
|-----|------|
| Host-level tag | That Host and, unless another selected tag only matches some of its Services, **all** of its Services (still clipped to the assembly when viewing inside a Group). |
| Service-level tag | That Host and **that Service only**. |
| Group filter | Only assemblies in the selected Groups. |
| Keyword | Address, aliases, port, tag, Group name. |

Worked example (company Group): Host `1.1.1.1` has Host tag `部门1`, `:80` tag `系统1`, `:443` tag `系统2`. Filter `部门1` AND `系统2` → Group「XXX公司」→ `1.1.1.1` → only `:443`.

Worked example (system Groups): filter Group=`系统2` AND tag=`数据库服务器` → Group「XXX系统2」→ `2.2.2.2` → `:1443`.

### UI (页内 Tab + 资产卡)

```
[搜索]  [标签]                                      [添加主机]
全部 | XXX公司  XXX系统1  未分组              新建组  编辑组
────────────────────────────────────────────────
┌ 1.1.1.1              80 / http     系统1     ┐
│ example.com          443 / https   系统2     │
│ 部门1                                        │
└──────────────────────────────────────────────┘
```

1. Same page chrome as 漏洞/专家：TopBar + filter + actions. **No second sidebar.**  
2. Groups are **page tabs**. **全部** is always first (unique Hosts, full ports). Named groups then 未分组. Click to switch the card list.  
3. Each Host is one Expert-style card: one hairline. Left identity (primary, aliases, Host tags); right one port per row (port, Service tags). No inner frames. Filter bar **排序**: default 地址（IPv4 按 octet 数值序，避免 `10.0.0.10` 排在 `10.0.0.2` 前；域名字母序，IP 在域名前）；可选添加时间 / 端口数 / 漏洞数。  
4. 「编辑组」opens the Group dialog. Pencil on a Host card → Host dialog（**编辑 / 端口 / 情报 / 漏洞**）。编辑 tab 写 `aliases[]`（同一主机的其它 IP/域名）；**备注不是身份**。端口 tab 勾选后批量删除。Click port → Service dialog。
5. Host 卡右上角图标：编辑 / 添加端口 / 删除主机。添加端口在卡内展开一行；当前组会把新端口收进该组装。删除主机走确认框。端口行 hover 右侧出删除，确认后从主机移除该端口。
6. 点击卡片选中（可多选），不进编辑。选中后「移动到」把主机从当前组装挪到目标组（带走当前端口子集）。有选中时「新建组」变为「新建并加入组」：创建 Group 后立刻 `batch-move` 已选主机入组（命名组 tab 下会从当前组移出）。多选条「移出」只拆组装（不删 Host）；「删除」彻底删台账 Host（二次确认；`POST /api/assets/batch-delete`）。批量移动/装入/移出走 `POST /api/asset-groups/batch-move`（单事务）。**多选跨搜索/标签/Tab 保留**；仅「取消」、批量操作成功、或 Host 删除后清空。
7. 右侧 Case Surface 树的 origin 行（hover「纳入」）是用户 promote：确认后 POST Host + 该 origin 的端口。不改 #368 树，不把路径抄进 Service 攻击面。**已入库判断 = Owner ledger（用户 `GET /api/assets` host:port）**，不是 Case snapshot 的 `conversation_id` 资产列表；已入库的 host:port 显示「已纳入」。

A Host can still belong to many Groups; the tab shows that Group’s port subset. Surface tab stays #368. No Service-cluster chrome.

---

## Layer split (locked)

| Layer | SoT | Job |
|-------|-----|-----|
| Case Surface | `surface_ledger` (#368) | This-Case NEW / TESTED / finding tags |
| Path novelty | `surface_inventory` (#410) | First-admit NEW; optional `asset_id` |
| Owner ledger | Group × Host × Service assembly (this Spec) | What the owner admits they have, how they group it, tags |
| Service 攻击面 | Paths on Service (Wave 2) | Company book of admitted paths |
| Traffic | #309 | Raw capture |

Do **not** auto-mirror Surface / #410 into Service 攻击面 except the Wave 2 admit set (book + accepted HTTP(S) settle). Do **not** treat inventory presence as TESTED.

---

## Out of Scope

- Reviving #322 Service cluster / 分身 / `asset_clusters`.
- Host-level cluster; auto-link `:80`↔`:443`; auto-merge vhost ↔ IP.
- Agent silent Host create, Agent-authored Groups or assemblies.
- Admitting every scanned or SYN-open port as a Service.
- Path Observation as a Service; Surface-tab inventory tree.
- Inventory as Graph L0 / Feedback success.
- Changing Finding identity (#275).
- Intel **law** lives in [`owner-intel.md`](owner-intel.md) (shipped: Host/Service hang + Findings 线索).
- External CMDB; org RBAC beyond current user-scoped assets.
- 巡检 / 整改 as new asset kinds — they reuse Host / Service / Finding when they ship.

---

## Testing Decisions

Good tests assert **external seam behavior**. Do not assert ORM names or React classes.

| Seam | Prove |
|------|--------|
| **S1 Host** | Identity = asset id. Same address may be many Hosts across Groups; merge only group-member address. Aliases = same machine only. `a.example.com` and `10.1.1.1` stay two Hosts unless aliases. Lookup by address/alias: unique → that id; **ambiguous (2+) → ask (`request_user_decision`); never first-match.** |
| **S2 Service** | Same host+port merges; different ports distinct; two ports keep separate tags. Scan-sized enrich does not admit. |
| **S3 Assembly** | Group1+Host1+{80,443} and Group2+Host1+{8080} coexist; opening Group2 does not show :80/:443. |
| **S4 Tags** | Host tag + Service tag AND filter matches sample (部门1 ∧ 系统2 → Host + :443 only). Tag write does not create a Group. |
| **S5 Scope** | Assembling a Group does not add members to `scope.allow`. User-authorized Host **ids** (decision card `asset_ids` / `options.asset_id`, 资产页开测, Workset adopt, or Case enroll_group of that discovery) become this Case Scope. Harness then projects intel; Agent continues the original task. |
| **S6 Surface isolation** | Inventory writes do not mark Case Surface TESTED. Wave 2 path admit does not rewrite #368/#410 rows. |
| **S7 Dual-read** | Until Service rows exist, `properties.services` + Host tags still list. No silent loss. |

**Primary seam:** platform owner-ledger domain module (extend `asset_ledger`; do **not** revive `asset_inventory` cluster helpers).

---

## Implementation slices

1. **#454a** — Group + assembly + tags on existing Host / `properties.services`. Asset page scheme B. No new path ledger. **Shipped** (`0012_owner_ledger`, `/api/asset-groups`, `/api/assets/tree`).  
2. **#454b** — First-class Service row (Host+port) + dual-read `properties.services`. Book / accepted HTTP(S) may upsert the port row (not the path). **Shipped** (`0013_owner_service_rows`, `asset_services`).  
3. **#454c** — Service 攻击面: persist admitted paths on Service from book / accepted HTTP(S) only. **Shipped** (`asset_service_paths`; attach on book + Surface HTTP settle, no #368/#410 rewrite).  
4. **Intel** — shipped; law in [`owner-intel.md`](owner-intel.md) (`0014_owner_intel`, `/api/intel`, node ledger tools).

#341 (tls Observation) stays deferred and is **not** a child of this Spec.

---

## Amendment history

| When | What |
|------|------|
| 2026-08-13 | New Spec #454. Retire #322 Host→Service+Cluster. Lock assembly, aliases vs vhost, scheme B UI, Wave 2 path admit. |
| 2026-08-13 | #454a: Group + assembly tables, tree API (AND search), scheme B `/assets`. Service stays in `properties.services`. |
| 2026-08-13 | #454b/#454c: official Service row + dual-read; book / accepted HTTP(S) admit port and path. Scan does not. |
| 2026-08-13 | UI: dense click-to-inspect tree. Drop checkbox / 创建任务. Group·Host·Port each open a ledger dialog. |
| 2026-08-13 | UI 方案 A 资产卡：组抽屉 + Host 卡（左身份/别名/tag，右端口一行一个）。 |
| 2026-08-13 | UI 档案布局：左分组列表，右当前组资产卡。 |
| 2026-08-13 | UI：去掉第二侧栏。组用页内 Tab；Host 用单层卡片。 |
| 2026-08-13 | UI：Host 卡右上角「添加端口」「删除主机」。当前组组装收进新端口。 |
| 2026-08-13 | UI：Host 对话框只留 编辑 / 情报 / 漏洞。端口与攻击面在卡和 Service 对话框。 |
| 2026-08-13 | UI：卡右上角改图标；点击卡片选中并可移动到其他组。 |
| 2026-08-14 | UI multi-select: `POST /api/asset-groups/batch-move` + `POST /api/assets/batch-delete` (one txn; was N× HTTP ~30s for /24). |
| 2026-08-14 | Host identity = id; Group-scoped merge only (cross-unit same IP = multiple Hosts; 未分组 may show two same IPs). |
| 2026-08-13 | UI：Host 对话框加回端口 tab，勾选后批量删除。 |
| 2026-08-13 | UI：组 Tab 常驻「全部」；筛选与组操作分行。 |
| 2026-08-14 | UI：右侧 Surface origin 可用户确认纳入资产库（Host + 该端口）。 |
| 2026-08-14 | Surface「已纳入」对照 Owner ledger（`GET /api/assets`），不限本 Case `conversation_id`。 |
| 2026-08-14 | 添加主机支持批量 CSV：`address,port,protocol,name[,tags]`；同一主机多行合并端口。 |
| 2026-08-14 | Agent chat-only 可只读 owner ledger（platform_list_assets）；与用户资产管理共用 Host 库；禁 recon 不禁 inventory。 |
| 2026-08-14 | 用户主动要求时 Agent 可 `platform_create_asset` 写 Host（含 CIDR≤256）；需 reason；enrich 仍不可偷建。 |
| 2026-08-14 | Agent: list_assets total/has_more；create/list groups；assemble；batch_enrich + remove_ports；identity=asset id（同 IP 跨单位可多 Host）。 |
| 2026-08-14 | UI: 全选/跨筛选 sticky 多选、移出 vs 删除、新建并加入组、排序（含 IP）、shadcn Select。 |
| 2026-08-14 | Agent 可见/装入 Group：`platform_list_groups` / `create_group` / `assemble_group`；create_asset 支持 group_name。 |
| 2026-08-15 | Intel wave law published: [`owner-intel.md`](owner-intel.md) (map #459). |
| 2026-08-15 | Intel shipped: Host/Service hang + Findings 线索 + Agent record/list/get/forget. |
| 2026-08-28 | Host 详情编辑 `aliases[]`（`PATCH /api/assets/{id}`）；备注不是身份。 |
| 2026-08-28 | Identity lookup: unique / none / **ambiguous (2+)** → `request_user_decision`; never first-match. |
| 2026-08-28 | Pentest Hard Graph `tools.allow` lists inventory reads (`platform_list_assets` / `get_asset` / `list_groups`); runner does not special-case them. |
| 2026-08-29 | Case asset-intake `enroll_group`: user-asked Group policy may enroll eligible Workset `t_host` into that Group + this Case Scope; Group assembly still does not pull other members into Scope. |
