# Finding identity + New-only narration

**Issue:** [#275](https://github.com/zangjiaao/my-ai-pen/issues/275)  
**Status:** implemented (identity + New-only narration)  
**Product path:** platform Vulnerability ledger + Node4 `finding(confirm)` (ADR 0001 Node4)

## Problem

Operators see Agent claim “新增 N 个漏洞” while the Case Findings panel shows fewer rows. Two causes:

1. **Over-broad ledger identity** — path-class aliases (e.g. `/hackable/uploads` ↔ `/vulnerabilities/upload`) and title-stem merge collapsed distinct issues (webshell RCE, credential exposure, phpinfo, directory listing) into one rediscovery of a historical upload finding.
2. **Narration vs ledger mismatch** — session local `finding(confirm)` success counts are not the same as **new** ledger rows; rediscovery badges added noise without fixing identity.

## Locked product decisions (grilling freeze)

| Decision | Choice |
|----------|--------|
| Unit | One ledger Vulnerability row = one followable finding |
| Identity | **asset or host-string + optional port + required `vuln_type` + file-level `location_key`** |
| Title | Does **not** participate in merge |
| Path aliases | **Removed** as merge primary key |
| `vuln_type` | Closed enum, **required** on confirm; missing → reject |
| Enum size | Medium set (~16 ids) |
| Incomplete keys | Degrade (host string / port optional); do not false-merge |
| Legacy rows | **No compatibility**; operator clears old vulns |
| Delivery | Identity + platform→agent structured outcome; no dual list |
| UI | Remove “再次发现 / 再次确认 N 次 / multiple_discoveries” badges; old rows default chrome |
| Narration | **User-visible text only describes New** (ledger `created=true`); rediscover is silent ledger update |

## Identity rules (normative)

Same finding (rediscover / update existing row) **only if**:

1. Same user, and  
2. Same **CVE** on same asset (when both sides have CVE), **or**  
3. Same **identity key**:
   - `asset_id` if present, else normalized **host** string from location/target  
   - `port` if present on either side: both must match when both set; missing port matches missing  
   - **`vuln_type`** exact enum id  
   - **`location_key`**: resource/file-level path (strip scheme/host; strip query by default; keep final path segment / file; **no** upload family aliases)

Otherwise → **create** a new ledger row (New).

## `vuln_type` closed set (V1 medium)

`rce`, `command_injection`, `file_upload`, `credential_exposure`, `info_disclosure`, `dir_listing`, `sqli`, `xss`, `csrf`, `lfi`, `ssrf`, `xxe`, `idor`, `auth_bypass`, `session`, `misconfig`, `other`

Unknown / empty → reject at Node tool and platform ingest.

## Seams (test at these)

1. **Primary (pure):** platform `finding_dedupe` — `location_resource_key`, `normalize_vuln_type`, `is_same_finding` under new rules. Prefer this seam over router integration for identity.
2. **Ingest boundary:** platform `vuln_found` persist — require `vuln_type`, store it, return `created` (and stop advertising multi-discovery UI fields as product surface).
3. **Node booking tool:** `finding(confirm)` — require `vuln_type`, pass on wire; tool result must not instruct “新增 N from confirm count”; prefer structured `ledger.created` when platform outcome is available.
4. **UI chrome:** Finding/chat cards — remove rediscovery / multiple_discoveries badges (history may remain for internal timeline if already stored).

## Out of scope

- Graph / Free / Route / C1 continue (tracked under wayfinder map #213 / Route grilling)
- Dual “session booked” vs ledger list UI
- Migrating or backfilling old vulnerability rows
- Answer keys / expected vuln matrices

## Living doc maintenance

Update this file when identity enum or merge rules change. Link from `docs/README.md`.
