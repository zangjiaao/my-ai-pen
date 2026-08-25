# Spec: Case traffic audit (replace right-panel Activity)

**Status:** job **A** implemented (Runtime hook collect → Platform store → Traffic panel). job **D** **normative, not implemented** — map [#442](https://github.com/zangjiaao/my-ai-pen/issues/442).  
**Issue:** [#309](https://github.com/zangjiaao/my-ai-pen/issues/309) (job A). job D: map [#442](https://github.com/zangjiaao/my-ai-pen/issues/442), tracker Spec [#514](https://github.com/zangjiaao/my-ai-pen/issues/514).  
**Related:** Product state → UI passive projection ([#280](https://github.com/zangjiaao/my-ai-pen/issues/280), `docs/specs/product-state-ui-projection.md`); Worker process audit (Agent process, not HTTP — `docs/specs/worker-process-audit.md`); Timeline activity liveness (Main chat chrome — not this panel); sticky pen-sandbox ([`pen-tools-sandbox.md`](pen-tools-sandbox.md), pointer-only for the observer); Surface TESTED is **not** this Spec (map [#504](https://github.com/zangjiaao/my-ai-pen/issues/504)).

**Product path:** Node4 Agent Runtime collect + Platform Case store/project + Conversation right panel  
**Research input (frozen third-party patterns, not product merge):** `research/anything-analyzer/`; seat MITM facts: map [#445](https://github.com/zangjiaao/my-ai-pen/issues/445).

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

**Phasing:** job **A** (shipped) = Runtime hooks. job **D** (this Spec, not built) = one **wire-grounded** observer on the sticky pen-sandbox; same exchange shape; MITM is the audit SoT.

**Later (Capture enrichment — not V1 DoD):** After exchanges are stored, Runtime may run **pluggable analyzers** on artifacts (especially JS/CSS bodies from SPA bundles) to mine **clues** (API path candidates, secret-shaped strings, internal hosts) and expose them to the **Agent** for analysis—see [`case-surface-ledger.md`](case-surface-ledger.md) **D6.2**. Clue mining is a Capture follow-on; Case Surface settle from request URLs is owned by the Surface Spec (v2).

---

## Product locks

1. **job A** fact-bypass hooks (shipped). **job D** seat P1 MITM — same exchange shape; MITM is the audit SoT when the observer is up.
2. **Replace** Activity in place; workflow timeline **not** a product commitment in this tab.
3. **Sources S2:** `http` tool + `browser` network + best-effort **`shell`** (curl/wget/httpie-style commands with absolute URLs). Not full MITM; non-HTTP shell egress stays out.
4. **List L1** + **Dialog U2** for detail.
5. **R2** two-phase pending → complete on one `exchange_id`.
6. **P2** Case-level persist; body truncation + length/hash.
7. **N3** default view; **F2** store fuller browser network than the default view.
8. **O1** Runtime hook collect only; no Agent “log traffic” maintenance tools; no tool-prose-as-SoT. **Read query** of session captures for raw material is separate (#378 `traffic_list`) and must not write surface ledger.
9. **C2** empty state when no exchanges; search + source filter toolbar (not a long honesty blurb).
10. **Out of job A:** intercept/replay, WS frame bodies, HAR export, cross-Case lake, finding attach UI, multi-field advanced filters, keep old Activity timeline. **job D** adds the observer (below); still out: intercept/edit/replay, analysis-product reports, scanner hitlists as DoD.

### Exchange record (logical shape)

- `exchange_id`, `conversation_id`, **`expert_id`** (Participant Session seat; job D required), optional `sequence`
- `source`: `http` | `browser` | `shell` | `mitm` (verb chip when labeled; not three ledgers)
- `phase`: `pending` | `completed` | `failed`
- method, url, request/response headers & bodies, status_code
- truncation metadata; browser resource class; optional `is_websocket`

### Collect / store / UI

- Node: hook inside `http` + browser `network requests` drain + shell post-exec best-effort HTTP parse; body budget default **64 KiB**/side (≤1 MiB research ceiling).
- Platform: Case-scoped `conversation.context["traffic_exchanges"]`; snapshot field `traffic_exchanges`; live WS `traffic_exchange` upsert-by-id after persist.
- FE: Traffic tab; N3 view filter pure function; search + source filter toolbar; L1 table (# newest-first, Method, Domain, Path, Status, Source, duration Time); center detail dialog (portal to body).

---

## Job D — seat observer (normative, not implemented)

**Purpose:** operators reconstruct **what this Agent is sending and how it is testing** — Agent-behavior audit, not a full-egress packet lake. Precise / objective = **wire-grounded** fields from the decrypting HTTP(S) observer, not tool-arg reconstruction or chat.

Map: [#442](https://github.com/zangjiaao/my-ai-pen/issues/442). Sandbox lifecycle remains [`pen-tools-sandbox.md`](pen-tools-sandbox.md); that file **points here** and does not co-own Traffic law.

### One pipe

When the seat observer is up, **MITM is the Traffic SoT**. Do not persist exchanges reconstructed from `curl`/`wget` argv. Do not treat browser `network requests` drain as a second ledger.

| Agent verb | Burp analogue | Capture when observer up | Source chip (verb) |
|---|---|---|---|
| `http` tool | Repeater | Node `fetch` through the seat P1 proxy | `http` |
| shell scripts (python/curl/wget) | hits Proxy | P1 env proxy | `mitm` |
| browser | embedded browser through proxy | Chromium **launch** `--proxy-server` / Playwright `proxy` + CA (env alone is not enough) | `browser` |

Do **not** auto-inject `-proxy`/`-x` into nuclei/ffuf. Scanner hitlists are **not DoD**; those tools keep native match logs. If the Agent themselves points a scanner at the proxy, rows land and the SQLite store may grow.

### Topology (P1)

- Explicit `http_proxy` / `https_proxy` + CA inside the sticky pen-sandbox. **Not** transparent REDIRECT/TPROXY. **Not** a shared host proxy with post-hoc labels.
- **One in-box observer per seat**, **one listen port per seat**. Env on that box points only at that port.
- Lifetime = sticky box: create with the seat; idle `docker stop` stops the observer; seat `rm` removes observer + CA.
- Reachability: sandbox clients (and Node Repeater when it uses the proxy) must be able to open the observer listen address. Bind/publish/host-net vs bridge is **implementation**. No WSL/Desktop product fork.

### CA

- **Generate at seat first start.** Do **not** bake a CA into the pen-sandbox image.
- Persist on container rootfs (mitmproxy `~/.mitmproxy` class): stop/start keep; **rm** destroys.
- V1: no operator rotation / download UI.
- Trust: Debian `update-ca-certificates` (curl/Go); `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` (Requests/certifi); Chromium launch CA trust.

### Always fields (TLS decrypted and the exchange transited the observer)

Binding: Case + seat `(conversation_id, expert_id)` — same key as the sticky box. Not pi `session_id`. Not `node_id` as ownership (Node is the ingest channel).

Plus: `exchange_id`, capture sequence, `started_at` / `completed_at`, method, full URL (scheme, host, port, path, query), `phase` + `status_code` (or transport `error`), Case-scoped headers (no extra MITM-only redaction in V1), request and response bodies **64 KiB/side** with truncation markers, byte length, hash. Binary content-types stay out of text (`*_body_binary`). Anything Analyzer-style always-record-response; do not copy 1 MiB as V1 default (1 MiB remains ceiling).

### Store and view

- **Working SoT:** Case-workspace SQLite (`workspace/case-{id}/`, same layer as Surface ledger). Agent may query anytime (`traffic_list` / equivalent).
- **Ingest:** persist HTTP that transited the observer (body budget as above). No write-only ingest drop; no tool-name denylist.
- **Default list / default Agent query:** hide static GET (`.js` / `.css` / images / fonts / `.map`) — Anything Analyzer assembler shape / existing N3. Full rows remain in SQLite.
- **Platform:** projection only; subset may be tightened later. `conversation.context["traffic_exchanges"]` ~500 JSON is **not** job D SoT.
- Panel source chips may name verbs; they are not three ledgers. Empty when nothing captured (observer down or no HTTP).

### TESTED

**Job D MITM does not drive Surface TESTED.** Audit pipe ≠ coverage chip. Do not default `source=mitm` → `purpose=test` for settle. Agent-maintained coverage is map [#504](https://github.com/zangjiaao/my-ai-pen/issues/504).

### Observer down

Audit is **not** a kill switch. If the observer is not listening: **do not inject** proxy env and **do not** point Chromium at the proxy. Agent work continues uncaptured. Traffic is an honest gap (no fake rows). Leaving proxy env pointed at a dead port (accidental fail-closed) is forbidden.

### Honest coverage (not 100%)

In: proxy-aware Agent scripts; Repeater when it can reach the port; browser when launch proxy+CA is set.

Out / gap: nmap SYN, redis, non-HTTP; cert pin; `unset HTTP_PROXY` / `trust_env=False` / `--noproxy`; HTTP/3-QUIC; nuclei/ffuf unless the Agent passes a proxy flag; Node Repeater if it cannot reach the listen address.

### Job D non-goals

Intercept/edit/replay; Anything Analyzer five-mode analysis reports / SceneDetector; scanner log panel; tool-name denylist; MITM auto-TESTED.

---

## Testing seams

| Seam | External behavior |
|------|-------------------|
| **S1 Runtime collect** | `http` start→pending; complete/fail→same id; `browser` shape `source=browser`; `shell` best-effort completed rows from curl-like commands; truncation metadata |
| **S2 Platform store/project** | Case-scoped persist; snapshot reload; live upsert; no cross-Case leak |
| **S3 Panel view model** | Traffic L1 newest-first table; N3 default filter; search/source filter; empty when no exchanges |
| **S4 Detail projection** | Dialog by id; pending waiting response; truncation markers |
| **S5 Seat observer** | P1 env+CA in sticky box; per-seat port; CA first-start not image-baked; stop/start keep, rm dies |
| **S6 One-pipe SoT** | Observer up → MITM rows; no argv-parse exchanges; no drain ledger; `http`/browser/scripts labeled as verbs |
| **S7 Store** | Case SQLite queryable; default view hides static GET; Platform subset projection; MITM does not set TESTED |
| **S8 Observer down** | No proxy injection; work continues; Traffic gap; no dead-port env left set |

---

## Out of Scope

- Intercept/edit/replay, WS frames, HAR, finding attach UI, complex filters, Soft Graph / Node5
- Analysis-product reports; scanner hitlists as Traffic DoD; baking MITM CA into the image
- Operator TESTED editing (Surface map [#504](https://github.com/zangjiaao/my-ai-pen/issues/504))
