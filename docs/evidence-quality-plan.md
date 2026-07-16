# Evidence quality plan (Case collaboration prerequisite)

> **Status:** living tracker  
> **Phase scheme:** **A → B → C → D → E** (original plan; do not renumber to B0–Bx)  
> **Precedence:** `AGENTS.md` → `prd.md` → this plan / `multi-expert-collaboration-plan.md`  
> **Why:** Multi-expert Case collab assumes **shared findings/evidence** with usable proof. Without durable proof on the Case, `case_context` and “next expert continues” fail.  
> **Non-goals:** Case shared-disk product; structured handoff protocol; stations.

**Related:** `node4-harness.md`, `node-expert-offers.md`, `benchmarks/collab-playbook-b/`.

---

## Progress

| Phase | Goal | Status | Notes |
|-------|------|--------|-------|
| **A** | 摸清生产/真 Case（只观测） | **Done** (2026-07-16) | Local workspaces + collab runs + `pentest_platform` DB; see §Phase A |
| **B** | Case 可读证据（P0） | Pending | Includes fixing empty Case `properties` so excerpts exist |
| **C** | 材料类证据（源码/笔记） | Pending | No shared disk; preview/path on Case |
| **D** | 降噪与语义 | Pending | proof vs trace; finding-linked; status honesty |
| **E** | 再跑剧本 B / 验收 | Pending | Success criteria in §Phase E |

Update this table when a phase completes (date + short note / commit).

---

## Collaboration model reminder (minimal)

```text
Case = Session
  ├── chat + findings + evidence  (shared truth)
  ├── case_context on task_assign (trimmed read for joining expert)
  └── user @ / select expert

Not required: structured handoff API, Case shared disk, stations
Materials → evidence (or clear chat paths), not a filesystem product
```

---

## Phase A — 摸清生产/真 Case（只观测） ✅ Done

### A.1 Checklist (original)

1. 抽真实 conversation / task：evidence 行数、type 分布、挂 finding 的比例、summary 可读率。  
2. 对照 UI / Agent：人审是否够；Agent 侧是否看不见 Case 证明。  
3. 验收指标草案（baseline 测量）：  
   - finding → evidence 解析率  
   - 「可证明」比例（有 body/stdout excerpt）  
   - 跨 task 可获取率  

### A.2 Samples inspected (2026-07-16)

| Source | Scale | Nature |
|--------|-------|--------|
| `node4/workspace/c6efe561-…` | 73 evidence / 17 findings | Live pentest (DVWA / Juice / platform API) |
| `node4/workspace/f56f5061-…` | 42 evidence / 20 findings | Live pentest (DVWA) |
| `node4/workspace/95ebf2f6-…` | 32 evidence / 14 findings | Mixed http/session/script |
| `benchmarks/collab-playbook-b/run/station*-ws*` | 14–31 evidence / 3–10 findings | Collab dry-run |
| Platform DB `pentest_platform` | **385** evidence / **73** vulns | Via `platform-db-1`; two main conversations |

### A.3 Architecture (as implemented)

| Layer | Storage | Lifetime |
|-------|---------|----------|
| Node task | `workspace/<taskId>/evidence/*.json` | Per burst; `finding(confirm)` validates **here** |
| Platform Case | DB `evidence` (`conversation_id`, `properties`) | Session-scoped; WS `evidence_created` |

```text
shell/http/session/… → emitEvidence → local JSON + evidence_created → platform
finding(confirm) → require local evidence_ids + demonstrable output → vuln_found
```

**Cross-task:** next expert’s new `taskDir` cannot read prior local files. Case DB is the intended share.

### A.4 Local Node (within one task)

**Strengths**

- `finding(confirm)` gates: `evidence_ids`, location, description, PoC shape, demonstrable stdout/body/redirect (`node4/src/tools/finding.ts`).
- Sampled findings: **100% had evidence_ids**; local files resolved.
- Good proofs: login 200/401 + body; session HTTP; collab static `proof_excerpts` from `cat` source.

**Weaknesses**

| Issue | Example |
|-------|---------|
| Orphan evidence (never referenced by finding) | c6efe ~55/73; f56f ~29/42; collab s3-v2 ~27/31 |
| One evidence → many unrelated findings | f56f one eid → upload RCE + stored XSS + reflected XSS + CSRF |
| Noise | `ls` / `total N`, empty stdout, empty session chains |
| Gate checks “has output”, not “supports this claim” | Shared mega-script stdout reused |
| No first-class file artifact type | Dumps via shell only; `write` does not emit evidence |

### A.5 Platform Case (shared layer) — critical

| Metric (2026-07-16) | Result |
|---------------------|--------|
| evidence rows | 385 |
| type `tool_output` / `evidence_created` | 240 / 145 |
| `raw_ref` empty | **385 / 385** |
| properties contain `stdout` | **0** |
| properties contain HTTP body keys | **0** |
| empty-ish properties | **~354 / 385** |
| non-proof `source_tool` (finding/todo/skill/read…) | ~89 |

**Smoking gun (same `evidence_id`):**

| | Local Node | Platform DB |
|--|------------|-------------|
| `ev_1784055584931_9679fd` | `data.stdout` ~1603 chars | `properties ≈ {"status": null, "stderr": ""}` |

**IDs sync; proof payload is hollow on Case.**  
UI may show summary only; Agent cannot reconstruct proof from Case today.

**Pollution:** tool return JSON as summary; finding/todo as evidence rows; dual noisy rows.

### A.6 Baseline metrics (draft values from Phase A)

| Metric | Baseline (approx.) | Notes |
|--------|--------------------|--------|
| finding→evidence 本地解析率 | ~100% on sampled tasks | Local files only |
| finding→evidence **Case 证明可读** | ~0% | properties empty |
| 可证明比例（本地 strong stdout/body） | high on linked eids; mixed overall | Many orphans/noise |
| 跨 task 可获取率（Agent） | **≈0** | No Case proof + no fetch |
| 跨 task 可获取率（若只认 id 存在） | partial | Ids often exist, content useless |

### A.7 UI / Agent contrast

| Actor | Can see Case evidence id? | Can see proof body? |
|-------|---------------------------|---------------------|
| Human (platform UI) | Often yes (list/summary) | **Weak** if properties empty |
| Next expert (Node) | Only via chat/`case_context` hints (`evidence:id`) | **No** — cannot load prior taskDir or rich Case properties |

### A.8 Code pointers

| Area | Path |
|------|------|
| Local store | `node4/src/stores/evidence.ts` |
| Emit | `node4/src/tools/common.ts` → `emitEvidence`, `evidencePropertiesForPlatform` |
| Finding gates | `node4/src/tools/finding.ts` |
| Booking nudges | `node4/src/runtime/booking-harness.ts` |
| Platform persist | `platform/backend/app/ws/router.py` → `_persist_evidence` |
| Model/API | `platform/backend/app/models/evidence.py`, `api/evidence.py` |
| case_context | `platform/backend/app/services/case_context.py` (hints only today) |
| Node inject | `node4/src/runtime/case-context.ts` |

### A.9 Phase A one-liner

**Local booking OK; Case evidence hollow; multi-expert continuation on Case proof not viable until Phase B (and D noise control).**

---

## Phase B — Case 可读证据（P0，核心）

**Goal:** 下一专家不用猜路径也能拿到证明材料。

**Depends on:** Phase A (done). **Must include** fixing empty Case `properties` — otherwise B.1 excerpts stay empty.

### B.1 `case_context` 增强（最小）

- 从 DB 拉本案 top-N **有用** evidence：  
  `id` / `summary` / `source_tool` / `kind` / path_or_url 提示 / **短 excerpt**  
- findings 板带上 `evidence_ids`  
- **仍不塞全文**（控 token）  
- Prefer evidence **referenced by findings** when selecting top-N (aligns with Phase D; can soft-prefer in B)

### B.2 Node 读 Case 证据（二选一或都做）

| Option | Approach | Note |
|--------|----------|------|
| **B.2a**（推荐先做） | platform 在 `task_assign` 附带 `case_evidence_snippets[]`（或 fold into `case_context`） | 少工具、与现有 assign 一致 |
| **B.2b** | 工具 `evidence(op=get, id)` → platform API | 更通用、按需拉 |

### B.3 入账时固化 proof 到 Case

- Trace + fix persist so Node `emitEvidence` **properties** (stdout/body/command/url/status/proof) land in DB (truncated OK).  
- `proof_excerpts` on `vuln_found`: ensure platform **persists** and appears in snapshot / case_context.  
- Finding 摘要足够时，下一位即使暂无 raw file 也能工作。

### B.4 Done when

- New run: Case evidence for act tools has **non-empty proof fields** (not only `{status, stderr}`).  
- Joining expert’s prompt includes **usable excerpts** for booked findings’ evidence_ids.  
- No dependency on copying prior `taskDir` paths for those proofs.

### B.5 Out of scope for B

- Case shared disk; UI redesign only; full noise taxonomy (Phase D).

---

## Phase C — 材料类证据（源码/笔记）

**Goal:** 源码 dump / 笔记可作为 Case 材料，而非共享盘。

1. 增加 `file_artifact` / `source_excerpt` 类型（或 shell 自动识别 `cat` 源码并打 kind）。  
2. 可选：`write` 关键文件时 emit evidence（path + hash + 短 preview）。  
3. **不搞 Case 共享盘**；内容或 preview 进 platform `properties`，path 作 hint。

**Done when:** Static collab can attach source proof as Case evidence with preview; next expert sees path + excerpt via case_context.

---

## Phase D — 降噪与语义

**Goal:** Case 上默认只有「证明」，且证明支撑 claim。

1. Evidence 分级：`proof` vs `trace`（**仅 proof** 默认进 `case_context`）。  
2. 或：**仅被 finding 引用的** evidence 进 `case_context`。  
3. finding 状态与动态失败对齐（`blocked_no_target` vs `confirmed`）。  
4. Tighten multi-finding reuse of one eid (claim-specific excerpt or disallow blind reuse).  
5. Stop non-proof tools (finding/todo/skill/read returns) from becoming Case evidence rows.

**Done when:** Orphan/noise rate down vs Phase A; multi-link abuse reduced; status language honest.

---

## Phase E — 再跑剧本 B / 验收

**Goal:** 证明协作闭环成立。

1. Re-run `benchmarks/collab-playbook-b`（优先 platform 路径，不单 standalone）。  
2. Re-sample platform metrics (A.5 table).  
3. Record pass/fail in Changelog below.

### Success criteria

| Check | Pass |
|-------|------|
| 站 3 **不靠**手写绝对路径 / 拷 HANDOFF | Y/N |
| `case_context` 能看到站 2 的 **proof 摘要** + evidence id **可解析出内容** | Y/N |
| 仍无 DVWA/范围外漂移 | Y/N |
| **无** Case 共享盘产品 | Y/N |
| 新 evidence properties 非空壳（act tools） | Y/N |

---

## Explicit non-goals

- Case shared filesystem product  
- Structured handoff as collaboration backbone  
- Stations UI  
- Weakening finding gates to inflate counts  
- Dumping all shell evidence into LLM context unfiltered  

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-16 | Phase A completed (local + DB sampling). Documented original **A–E** plan (not B0–Bx). Critical finding: Case properties hollow. |
| 2026-07-16 | Doc rewritten to restore A–E naming after a temporary B0–B4 renumber; content aligned to original plan + Phase A facts. |
