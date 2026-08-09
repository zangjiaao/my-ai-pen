# Spec: Case traffic audit (replace right-panel Activity)

**Status:** implemented (vertical slice: Runtime collect → Platform store → Traffic panel; browser network best-effort via agent-browser)  
**Issue:** [#309](https://github.com/zangjiaao/my-ai-pen/issues/309)  
**Related:** Product state → UI passive projection ([#280](https://github.com/zangjiaao/my-ai-pen/issues/280), `docs/specs/product-state-ui-projection.md`); Worker process audit (Agent process, not HTTP — `docs/specs/worker-process-audit.md`); Timeline activity liveness (Main chat chrome — not this panel)

**Product path:** Node4 Agent Runtime collect + Platform Case store/project + Conversation right panel  
**Research input (frozen third-party patterns, not product merge):** `docs/wayfinder/research-anything-analyzer-traffic-audit-patterns.md` (`research/anything-analyzer/`)

**Does not implement product code in this document** — normative contracts only.

---

## Problem Statement

Operators watching a Case cannot see **what HTTP traffic the Agent actually produced**. The right-panel **Activity** tab was a workflow/plan timeline derived from messages — not network truth.

## Solution

**Replace** the right-panel **Activity** tab with a **Case traffic audit** list:

- Each row is one **HTTP exchange** collected by **Node Runtime hooks** on the `http` tool, the `browser` network layer, and best-effort `shell` (curl/wget/httpie).
- **L1 list (newest-first):** search + source filter toolbar; columns `#` (capture sequence) · Method · Domain · Path · Status · Source (`http` | `browser` | `curl` for shell) · Time (duration).
- **Click → center Dialog:** raw request/response text with capture-time truncation markers (portal to viewport).
- **Two-phase liveness:** emit **pending** when the request starts; **update the same exchange id** when the response (or failure/timeout) completes.
- **Case-scoped persistence:** refresh/reload still shows history for this conversation.
- **Honest coverage:** default browser **view** shows document + XHR/Fetch + WebSocket-class rows (hide static noise); store still keeps fuller browser network (subject to body budget).

**Roles (same split as #280):** Agent calls tools only · Node Runtime hook-collects · Platform stores/projects · Frontend projects SoT.

**Phasing:** V1 = job **A** (fact-bypass observability). Future job **D** (full egress MITM) reuses the same exchange shape + new `source`.

**Later (Capture enrichment — not V1 DoD):** After exchanges are stored, Runtime may run **pluggable analyzers** on artifacts (especially JS/CSS bodies from SPA bundles) to mine **clues** (API path candidates, secret-shaped strings, internal hosts) and expose them to the **Agent** for analysis—see [`case-surface-ledger.md`](case-surface-ledger.md) **D6.2**. Clue mining is a Capture follow-on; Case Surface settle from request URLs is owned by the Surface Spec (v2).

---

## Product locks

1. **V1 job A** fact-bypass; **future job D** full MITM — same pipeline, new source.
2. **Replace** Activity in place; workflow timeline **not** a product commitment in this tab.
3. **Sources S2:** `http` tool + `browser` network + best-effort **`shell`** (curl/wget/httpie-style commands with absolute URLs). Not full MITM; non-HTTP shell egress stays out.
4. **List L1** + **Dialog U2** for detail.
5. **R2** two-phase pending → complete on one `exchange_id`.
6. **P2** Case-level persist; body truncation + length/hash.
7. **N3** default view; **F2** store fuller browser network than the default view.
8. **O1** Runtime hook collect only; no Agent “log traffic” maintenance tools; no tool-prose-as-SoT. **Read query** of session captures for raw material is separate (#378 `traffic_list`) and must not write surface ledger.
9. **C2** empty state when no exchanges; search + source filter toolbar (not a long honesty blurb).
10. **Out of V1:** intercept/replay, MITM, WS frame bodies, HAR export, cross-Case lake, finding attach UI, multi-field advanced filters, keep old Activity timeline.

### Exchange record (logical shape)

- `exchange_id`, `conversation_id`, optional `sequence`
- `source`: `http` | `browser` | `shell` (| future `mitm`)
- `phase`: `pending` | `completed` | `failed`
- method, url, request/response headers & bodies, status_code
- truncation metadata; browser resource class; optional `is_websocket`

### Collect / store / UI

- Node: hook inside `http` + browser `network requests` drain + shell post-exec best-effort HTTP parse; body budget default **64 KiB**/side (≤1 MiB research ceiling).
- Platform: Case-scoped `conversation.context["traffic_exchanges"]`; snapshot field `traffic_exchanges`; live WS `traffic_exchange` upsert-by-id after persist.
- FE: Traffic tab; N3 view filter pure function; search + source filter toolbar; L1 table (# newest-first, Method, Domain, Path, Status, Source, duration Time); center detail dialog (portal to body).

---

## Testing seams

| Seam | External behavior |
|------|-------------------|
| **S1 Runtime collect** | `http` start→pending; complete/fail→same id; `browser` shape `source=browser`; `shell` best-effort completed rows from curl-like commands; truncation metadata |
| **S2 Platform store/project** | Case-scoped persist; snapshot reload; live upsert; no cross-Case leak |
| **S3 Panel view model** | Traffic L1 newest-first table; N3 default filter; search/source filter; empty when no exchanges |
| **S4 Detail projection** | Dialog by id; pending waiting response; truncation markers |

---

## Out of Scope

- Intercept/edit/replay, full MITM, shell traffic, WS frames, HAR, finding attach UI, complex filters, Soft Graph / Node5
