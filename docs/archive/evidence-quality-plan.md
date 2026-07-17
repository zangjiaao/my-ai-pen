# Evidence quality plan (Case collaboration prerequisite)

> **ARCHIVED 2026-07-17** — Phases **A–E complete**. Not implementation authority.  
> Living behavior: `docs/prd.md`, `docs/node4-harness.md`, Node4 booking / `case_context` code.  
> **Phase scheme (historical):** **A → B → C → D → E**  
> **Why (historical):** Multi-expert Case collab needed shared findings/evidence with usable proof.  
> **Non-goals:** Case shared-disk product; structured handoff protocol; stations.

**Related (living):** `docs/prd.md`, `docs/node4-harness.md`, `docs/node-expert-offers.md`.

---

## Progress

| Phase | Goal | Status | Notes |
|-------|------|--------|-------|
| **A** | 摸清生产/真 Case（只观测） | **Done** (2026-07-16) | Local workspaces + collab runs + `pentest_platform` DB; see §Phase A |
| **B** | Case 可读证据（P0） | **Done** (2026-07-16) | case_context v2 snippets; findings.evidence_ids; durable properties + hollow backfill |
| **C** | 材料类证据（源码/笔记） | **Done** (2026-07-16) | write → file_artifact / source_excerpt (path + preview + hash) |
| **D** | 降噪与语义 | **Done** (2026-07-16) | role proof\|trace; collab prefers linked+proof; read 不入账 |
| **E** | 验收 | **Done** (unit + live DVWA) | Unit gates + live DVWA on host.docker.internal:8080 (see Changelog) |

Update this table when a phase completes (date + short note / commit).

---

## Collaboration model (shared Case evidence)

```text
Case = Session (shared truth for all experts)
  ├── chat
  ├── findings  (conclusions — what was found)
  └── evidence  (materials — path / request / stdout that prove it)

task_assign → case_context (trimmed read for joining expert)
  ├── findings_summary[]  + evidence_ids + short proof
  └── evidence_snippets[] (prefer finding-linked proof)

Not required: structured handoff API, Case shared disk, stations
Materials → Case evidence (path + preview), not a filesystem product
```

**Example (multi-expert):**

1. **Pentest** books finding “source leak” with evidence that includes path + listing/preview.  
2. **Code-audit** joins the same Case, reads `case_context.evidence_snippets` / finding `evidence_ids`, continues from those paths — **no** prior `taskDir` copy.

**User-facing layers on a finding (simple trust model):**

1. **Proof** — short excerpts that demonstrate the claim (primary; enough to trust the issue exists)  
2. **How to reproduce** — PoC steps + observed result (helps the user / next expert replay)  
3. **Materials** — linked `evidence_ids` (expandable; one strong proving observation is enough; full archaeology optional)

**Principle:** Finding = user-trustable conclusion; Evidence = materials that support that claim (created **at booking** from agent `proof`). Act tools keep recent observations in memory only (anti-hallucination); they do **not** flood Case with orphan logs.

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
shell/http/session/… → recordActObservation (memory only; not Case)
finding(confirm) + proof (quoted from tool output)
  → ground proof in recent observations
  → emitCaseEvidence (1 linked proof) + vuln_found
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
| case_context | `platform/backend/app/services/case_context.py` |
| Node inject | `node4/src/runtime/case-context.ts` |

### A.9 Phase A one-liner

**Local booking OK; Case evidence hollow; multi-expert continuation on Case proof not viable until Phase B (and D noise control).**

---

## Phase B — Case 可读证据（P0，核心）

**Goal:** 下一专家不用猜路径也能拿到证明材料。

**Depends on:** Phase A (done). **Must include** fixing empty Case `properties` — otherwise B.1 excerpts stay empty.

### B.1 `case_context` 增强（最小）

- 从 DB 拉本案 top-N **有用** evidence：  
  `id` / `summary` / `source_tool` / `kind` / path_or_url 提示 / **短 excerpt** / `role`  
- findings 板带上 `evidence_ids` + 短 proof  
- **仍不塞全文**（控 token）  
- Prefer evidence **referenced by findings** when selecting top-N

### B.2 Node 读 Case 证据

| Option | Approach | Note |
|--------|----------|------|
| **B.2a**（本轮） | fold `evidence_snippets[]` into `case_context` on `task_assign` | 少工具、与现有 assign 一致 |
| **B.2b** | 工具 `evidence(op=get, id)` → platform API | 后置；UI/API 已有 GET `/api/evidence/{id}` |

### B.3 入账时固化 proof 到 Case

- Node `emitEvidence` properties 带 `role` / `kind` / `excerpt` / path_or_url / body|stdout（截断）。  
- `vuln_found` 时若 linked evidence 空壳，用 `proof_excerpts` **回填** Case properties。  
- `proof_excerpts` 继续写入 description/PoC 供人审。

### B.4 Done when

- New run: Case evidence for act tools has **non-empty proof fields**.  
- Joining expert’s prompt includes **usable excerpts** for booked findings’ evidence_ids.  
- No dependency on copying prior `taskDir` paths for those proofs.

### B.5 Out of scope for B

- Case shared disk; full UI redesign; full noise taxonomy (Phase D).

---

## Phase C — 材料类证据（源码/笔记）

**Goal:** 源码 dump / 笔记可作为 Case 材料，而非共享盘。

1. `kind=file` / `source_excerpt`（或 write 自动 file_artifact）。  
2. `write` 关键文件时 emit evidence（path + hash + 短 preview）。  
3. **不搞 Case 共享盘**；preview 进 platform `properties`，path 作 hint。

**Done when:** Static collab can attach source proof as Case evidence with preview; next expert sees path + excerpt via case_context.

---

## Phase D — 降噪与语义

**Goal:** Case 上默认只有「证明」，且证明支撑 claim。

1. Evidence 分级：`role: proof | trace`（**优先 proof** 进 `case_context`）。  
2. **优先被 finding 引用的** evidence 进 `case_context`。  
3. finding 状态与动态失败对齐（诚实 status 语言）。  
4. multi-finding：每 finding 存 claim-specific `proof_excerpts`（已有）。  
5. 非 act 工具不 emit Case evidence（finding/todo/skill/read 保持不入账）。

**Done when:** Orphan/noise rate down vs Phase A for **default collab view**; multi-link abuse reduced at booking; status language honest.

---

## Phase E — 验收

**Goal:** 证明协作闭环成立。

1. Unit/smoke：case_context snippets、properties role/excerpt、write file evidence。  
2. （可选）Re-run `benchmarks/collab-playbook-b` platform path。  
3. Record pass/fail in Changelog.

### Success criteria

| Check | Pass |
|-------|------|
| 站 3 **不靠**手写绝对路径 / 拷 HANDOFF | Y/N |
| `case_context` 能看到站 2 的 **proof 摘要** + evidence id **可解析出内容** | Y/N |
| 仍无 DVWA/范围外漂移 | Y/N |
| **无** Case 共享盘产品 | Y/N |
| 新 evidence properties 非空壳（act tools） | Y/N |
| 源码类 material 带 path + preview 可给 code-audit | Y/N |

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
| 2026-07-16 | Phase A completed (local + DB sampling). Documented original **A–E** plan. Critical finding: Case properties hollow. |
| 2026-07-16 | Doc rewritten to restore A–E naming after a temporary B0–B4 renumber. |
| 2026-07-16 | Clarified multi-expert shared Case evidence model; B–E implementation starts (snippets, durable properties, file materials, proof/trace). |
| 2026-07-16 | **B–E implemented:** `case_context` v2 `evidence_snippets` + findings `evidence_ids`/`proof_excerpt`; Node properties `role`/`excerpt`/`path_or_url`; hollow evidence backfill from `proof_excerpts` on `vuln_found`; `write` file_artifact; proof/trace filter in collab context. Unit tests: platform case_context helpers + node case-context/common evidence. Live collab-playbook-b re-run still optional. |
| 2026-07-16 | **Live DVWA acceptance** (`http://host.docker.internal:8080`, Node4 pentest pack, ~7.5min): 42 `evidence_created`, 11 `vuln_found`. Act **proof** hollow **0/40**; linked evidence readable **10/10**; case_context 12 snippets + 11 findings with eids/proof. Residual gaps (then fixed): empty-body browser/http → `role=trace`; mega-script multi-finding reuse capped + location must appear in shared excerpt; path hints reject regex noise; shell `notes/source_dump` → `source_excerpt` kind. Standalone does **not** require platform backend (Case DB only for multi-expert share). Artifacts: `node4/workspace/dvwa-evidence-live/2026-07-16T14-57-01/`. |
| 2026-07-16 | **Platform Case E2E** (backend :8000 + WS node + real DVWA): Case DB `properties` non-hollow for act proof; `source_excerpt` path/preview persisted; mass-reuse of 3rd finding rejected; API list + `load_case_context` snippets ok. Runner: `node4/src/platform-evidence-e2e.ts`, report under `node4/workspace/platform-evidence-e2e/`. |
| 2026-07-16 | **Stable platform DVWA live** (~9.4min, conv `bbaf70ad-…`): 11 findings / 11 modules (core sqli+exec+xss_r all hit); Case DB 45 evidence hollow=0; handoff_ready 10/11→re-score 11/11 after poc Visit keywords. Report: `node4/workspace/dvwa-platform-live/2026-07-16T15-32-01/finding-handoff-score.md`. |
| 2026-07-16 | **Fix pack:** poc action words (+visit/open/… + /vulnerabilities/path); **strict 1 evidence_id ↔ 1 finding**; UI `evidenceDisplay` reads body_preview/excerpt/source_excerpt/file preview; EvidenceDetailDialog file+role badges. |
| 2026-07-17 | **Proof-vs-process:** script/shell evidence now prioritizes **observation** (CONFIRMED/Context/payload HTML/HTTP lines) over process wrapper (script path, exit code). Agent `scripts/*_probe.py` no longer classified as `source_excerpt`. Booking excerpts + UI “Proving observation” first; “How captured” secondary. Harness prefers http/session for web proofs. |
| 2026-07-17 | **Proof-first live** conv `e9ae3ce5-…`: 10 findings / 10 modules; linked all have `observation`; process_first on linked=0; exclusive eids; hollow 2/89. Stored XSS excerpt shows payload HTML not script path. Residual: `write scripts/*.py` still kind=source (fixed after run); orphan noise still high; shell still dominant capture mode. |
| 2026-07-17 | **Discovery-chain model:** Reverted strict 1 finding↔1 evidence. A finding’s `evidence_ids` is an **ordered discovery path** (setup→probe→prove); ≥1 proving step required; supporting steps allowed. Cross-finding mega-script reuse still capped. UI labels Evidence as Discovery path (Step N / Proof). Orphans = not hung on any finding’s chain — agent should attach the path when booking. |
| 2026-07-17 | **Chain live** conv `43485bd6-…`: 12 findings, **100% multi-step** (avg chain 2.42, SQLi chain=6); linked 27/89 (30% vs ~22% before); handoff 12/12 strong. SQLi path: login → cookie → welcome → syntax error → ORDER BY → UNION hashes. Residual orphan ~70% still global noise. |
| 2026-07-17 | **Chain live re-run** conv `eef7eebc-…`: multi-step regressed 2/11 (avg 1.27); 5 shared mega-eids. Chose OMP-aligned fix: soft `booking_nudge` on short chain / shared proving eids (still books); no `n≥2` hard gate. |
| 2026-07-17 | **Soft booking chain quality:** `assessBookingChainQuality` in `booking-harness.ts`; finding(confirm) success returns `chain_quality` + optional `booking_nudge`. Hard rejects unchanged (empty proof, mass-reuse cap, shared-only unrelated proof). |
| 2026-07-17 | **Soft-nudge live** conv `ab52720c-…`: 10 findings, multi-step **3/10** (avg 1.30), shared eids=4; handoff 10/10 strong, hollow=0. Soft tip **fired** (transcript `booking_nudge`×16, events×12) but agent often kept booking single-step after tip — soft feedback reaches model; in-loop shape still weak vs best run `43485bd6` (12/12 multi). Residual: improve decision path (batch book after multi capture) rather than hard gates. |
| 2026-07-17 | **Trust-first simplify:** Product model = Finding trustable conclusion / Evidence supporting materials (enough to trust + reproduce). Drop multi-step archaeology pressure. Soft `booking_nudge` only when shared proving evidence does not support this location. Live instruction + harness copy aligned. |
| 2026-07-17 | **Trust-first live** conv `01035375-…`: 10 findings / 75 evidence; handoff 9 strong + 1 usable (captcha); core sqli+exec+xss_r hit; hollow=0; orphan~85% (expected log noise). Residual agent quality: JS finding hung CSRF evidence; captcha hung login password brute; one shared eid (CSRF+JS). Soft nudge count 0 (no short-chain nag). Evidence system frozen as-is. |
| 2026-07-17 | **Book-time evidence model:** Act tools `recordActObservation` only (no Case flood). `finding(confirm)` requires `proof` grounded in recent tool output; system `emitCaseEvidence` creates linked Case proof. Agent no longer hunts `evidence_ids`. |
| 2026-07-17 | **Book-time live** conv `eb628a81-…`: 9 findings / **9 evidence all `source_tool=finding`**; orphan **0%**; 1:1 linked; handoff core modules hit. No act-tool Case flood. |
| 2026-07-17 | **Score/collab polish:** `score-dvwa-evidence` / handoff score for book-time; case_context treats `source_tool=finding` as product proof (not meta noise); excerpt reads `observation`/`proof` strings; pentest `work.md` + harness docs aligned. |
| 2026-07-17 | **How-captured causality:** recent observations store command/HTTP/script capture; book-time evidence attaches `how_captured` + command/method/url/script_preview; UI shows Result then How (request/command). |
| 2026-07-17 | **How UI rewrite:** Replace vague “How captured” (path=location, exit 0) with **1. Result / 2. What the agent did** (Shell command | HTTP request | Script | Not recorded). Old book-time rows without command show honest “Not recorded”. |
| 2026-07-17 | **Script+result proof:** Book-time match prefers observations with command; attaches write() script body when shell ran `python scripts/…`; UI shows Result + script/command. Fixes “Stored XSS only shows result, Not recorded”. |
| 2026-07-17 | **Evidence step cards UI:** Unified cards `0 Evidence → 1 Agent command → 2 Script/request → 3 Execution result` (same format every step) so judgment basis + how obtained are scannable. |
| 2026-07-17 | **Evidence in finding only:** Drop separate “product detail card” UX for proof; finding panel shows compact steps `1 Command → 2 Script/request → 3 Result` inline (no click-out required). |
