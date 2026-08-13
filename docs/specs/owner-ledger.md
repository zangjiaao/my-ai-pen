# Spec: Owner ledger (Group × Host × Service assembly)

**Status:** Living Spec — **locked model**. **#454a / #454b / #454c shipped**. Intel is not this Spec.  
**Tracker:** [#454](https://github.com/zangjiaao/my-ai-pen/issues/454)  
**Supersedes:** [#322](https://github.com/zangjiaao/my-ai-pen/issues/322) and implementation tickets [#340](https://github.com/zangjiaao/my-ai-pen/issues/340)–[#345](https://github.com/zangjiaao/my-ai-pen/issues/345). Do **not** amend or revive `docs/specs/asset-inventory.md` (deleted with the #322 revert).  
**Related:** Case Surface [`case-surface-ledger.md`](case-surface-ledger.md) / [#368](https://github.com/zangjiaao/my-ai-pen/issues/368); NEW precipitation [#410](https://github.com/zangjiaao/my-ai-pen/issues/410) / [`surface-new-tested-coverage.md`](surface-new-tested-coverage.md); product-state UI [#280](https://github.com/zangjiaao/my-ai-pen/issues/280); finding identity [#275](https://github.com/zangjiaao/my-ai-pen/issues/275).

**Product path:** Platform owner ledger on Node4 Graph × Pi (ADR 0001). Not a new Node kernel.

**Does not reintroduce:** Soft product mode; dual-kernel; Service cluster / 分身; Host-level cluster; path-as-Service; Surface tab as inventory tree; Agent silent Host create; keyword intent routing.

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
| **Host** | One owner-enrolled address card: primary IP **or** domain + optional **aliases** (child addresses). Agent treats aliases as the same machine. Agent **never** creates Hosts. |
| **Service** | That Host + one port. Proto/name are display. No Service without a Host. Same IP two ports = two Services. |
| **Assembly** | Explicit user relation: **Group + Host + a chosen subset of that Host’s Services**. Empty port subset = bare Host in that Group (show the Host, no ports). |
| **Tag** | Label on a **Host** or a **Service**. Not required to assemble, book, or admit. |
| **Service 攻击面** | Durable paths under a Service (company book). Enter only from `finding(confirm)` or an **accepted HTTP(S) Traffic settle** on an **existing** Host. Scan / SYN does not. Do not create a Host to hang a path. |
| **Finding** | Stays `asset_id` + `port` (existing law / #275). Service is the face those two already name. No cluster merge. No new Finding PK. |
| **Intel** | Info blocks on Group / Host / Service. **Not this wave.** |

### Aliases vs vhosts (do not collapse)

| Case | Object |
|------|--------|
| `1.1.1.1` with children `example.com`, `10.0.0.1` | **One Host**, aliases. Agent: same machine. |
| `a.example.com:443`, `b.example.com:443`, `10.1.1.1:443` | **Three Hosts**. Even if DNS says one IP, surfaces stay apart. |

Do **not** auto-merge a vhost into an IP Host. Do **not** invent a Service cluster that links `shop.example.com:443` to `203.0.113.10:443`.

### Writes

| # | Lock |
|---|------|
| **Host** | User create / authorize-register / promote (existing). Agent enrich ports/notes on an existing Host only. |
| **Service row** | User adds a port on a Host, **or** book / accepted HTTP(S) settle names that `host:port` on an existing Host. nmap-sized dumps do not become Service rows. |
| **Group** | User create / rename / delete. Agent does **not** create Groups. |
| **Assembly** | User puts a Host into a Group and picks which Services belong there. Adding a Host to a Group does **not** imply every port. Removing the last Service from an assembly leaves a bare Host in the Group or removes the Host from the Group (UI: user chooses). |
| **Tags** | User (and Agent, non-`sys`) on Host or Service. Editing a tag does **not** create or extend a Group. |
| **Path onto Service 攻击面** | Book or accepted HTTP(S) settle only. Wave 2 — do not block Wave 1 tree on path persist. |
| **Scope** | Still **host-based**. Assembly / Group membership does **not** auto-expand `scope.allow`. Honest warning if a Host has Services outside the Group being dispatched. |

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

### UI (scheme B — locked)

```
[关键词]   [组 多选]   [tag 多选]

▼ XXX公司
    ▶ 1.1.1.1   (aliases…)              部门1
    ▼ 2.2.2.2                           系统2 · 部门2
        1443/tcp
```

1. Filter row: keyword, Group multi-select, tag multi-select.  
2. Group row: drawer, expand/collapse.  
3. Host row: primary address, aliases, tags on the right; expand/collapse.  
4. Port row: one Service; port on the left, tags on the right.

The same Host may appear under two open Groups with different port lists. Surface tab stays #368. No Service-cluster chrome.

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
- Intel blocks (later; hang on Group / Host / Service, no new asset kind).
- External CMDB; org RBAC beyond current user-scoped assets.
- 巡检 / 整改 as new asset kinds — they reuse Host / Service / Finding when they ship.

---

## Testing Decisions

Good tests assert **external seam behavior**. Do not assert ORM names or React classes.

| Seam | Prove |
|------|--------|
| **S1 Host** | One address one Host; aliases merge onto the same card; `a.example.com` and `10.1.1.1` stay two Hosts. Agent cannot create Hosts. |
| **S2 Service** | Same host+port merges; different ports distinct; two ports keep separate tags. Scan-sized enrich does not admit. |
| **S3 Assembly** | Group1+Host1+{80,443} and Group2+Host1+{8080} coexist; opening Group2 does not show :80/:443. |
| **S4 Tags** | Host tag + Service tag AND filter matches sample (部门1 ∧ 系统2 → Host + :443 only). Tag write does not create a Group. |
| **S5 Scope** | Assembling a Group does not add members to `scope.allow`. |
| **S6 Surface isolation** | Inventory writes do not mark Case Surface TESTED. Wave 2 path admit does not rewrite #368/#410 rows. |
| **S7 Dual-read** | Until Service rows exist, `properties.services` + Host tags still list. No silent loss. |

**Primary seam:** platform owner-ledger domain module (extend `asset_ledger`; do **not** revive `asset_inventory` cluster helpers).

---

## Implementation slices

1. **#454a** — Group + assembly + tags on existing Host / `properties.services`. Asset page scheme B. No new path ledger. **Shipped** (`0012_owner_ledger`, `/api/asset-groups`, `/api/assets/tree`).  
2. **#454b** — First-class Service row (Host+port) + dual-read `properties.services`. Book / accepted HTTP(S) may upsert the port row (not the path). **Shipped** (`0013_owner_service_rows`, `asset_services`).  
3. **#454c** — Service 攻击面: persist admitted paths on Service from book / accepted HTTP(S) only. **Shipped** (`asset_service_paths`; attach on book + Surface HTTP settle, no #368/#410 rewrite).  
4. **Intel** — later, not numbered here.

#341 (tls Observation) stays deferred and is **not** a child of this Spec.

---

## Amendment history

| When | What |
|------|------|
| 2026-08-13 | New Spec #454. Retire #322 Host→Service+Cluster. Lock assembly, aliases vs vhost, scheme B UI, Wave 2 path admit. |
| 2026-08-13 | #454a: Group + assembly tables, tree API (AND search), scheme B `/assets`. Service stays in `properties.services`. |
| 2026-08-13 | #454b/#454c: official Service row + dual-read; book / accepted HTTP(S) admit port and path. Scan does not. |
