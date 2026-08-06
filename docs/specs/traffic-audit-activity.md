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

- Each row is one **HTTP exchange** collected by **Node Runtime hooks** on the `http` tool and the `browser` network layer.
- **L1 list:** method · status · host/path · wall time · source chip (`http` | `browser`).
- **Click → center Dialog:** raw request/response text with capture-time truncation markers.
- **Two-phase liveness:** emit **pending** when the request starts; **update the same exchange id** when the response (or failure/timeout) completes.
- **Case-scoped persistence:** refresh/reload still shows history for this conversation.
- **Honest coverage:** default browser **view** shows document + XHR/Fetch + WebSocket-class rows (hide static noise); store still keeps fuller browser network (subject to body budget).

**Roles (same split as #280):** Agent calls tools only · Node Runtime hook-collects · Platform stores/projects · Frontend projects SoT.

**Phasing:** V1 = job **A** (fact-bypass observability). Future job **D** (full egress MITM) reuses the same exchange shape + new `source`.

---

## Product locks

1. **V1 job A** fact-bypass; **future job D** full MITM — same pipeline, new source.
2. **Replace** Activity in place; workflow timeline **not** a product commitment in this tab.
3. **Sources S2:** `http` tool + `browser` network only.
4. **List L1** + **Dialog U2** for detail.
5. **R2** two-phase pending → complete on one `exchange_id`.
6. **P2** Case-level persist; body truncation + length/hash.
7. **N3** default view; **F2** store fuller browser network than the default view.
8. **O1** Runtime hook collect only; no Agent traffic tools; no tool-prose-as-SoT.
9. **C2** honesty line + empty state.
10. **Out of V1:** intercept/replay, MITM, WS frame bodies, HAR export, cross-Case lake, finding attach UI, complex filters, keep old Activity timeline.

### Exchange record (logical shape)

- `exchange_id`, `conversation_id`, optional `sequence`
- `source`: `http` | `browser` (| future `mitm`)
- `phase`: `pending` | `completed` | `failed`
- method, url, request/response headers & bodies, status_code
- truncation metadata; browser resource class; optional `is_websocket`

### Collect / store / UI

- Node: hook inside `http` + browser `network requests` drain; body budget default **64 KiB**/side (≤1 MiB research ceiling).
- Platform: Case-scoped `conversation.context["traffic_exchanges"]`; snapshot field `traffic_exchanges`; live WS `traffic_exchange` upsert-by-id after persist.
- FE: Traffic tab; N3 view filter pure function; center detail dialog; C2 honesty copy.

---

## Testing seams

| Seam | External behavior |
|------|-------------------|
| **S1 Runtime collect** | `http` start→pending; complete/fail→same id; `browser` shape `source=browser`; truncation metadata |
| **S2 Platform store/project** | Case-scoped persist; snapshot reload; live upsert; no cross-Case leak |
| **S3 Panel view model** | Traffic L1; N3 default filter; honesty when empty |
| **S4 Detail projection** | Dialog by id; pending waiting response; truncation markers |

---

## Out of Scope

- Intercept/edit/replay, full MITM, shell traffic, WS frames, HAR, finding attach UI, complex filters, Soft Graph / Node5
