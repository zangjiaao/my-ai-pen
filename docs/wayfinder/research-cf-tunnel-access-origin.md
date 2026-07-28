# Research: cloudflared Docker + Cloudflare Access + same-origin reverse proxy

> Ticket: GitHub **#226** · Map **#151** (charting locks **Pkg-D**, **Entry-P**, **Access-X**)  
> Research only — **no product feature code** in this resolution.  
> Date: 2026-07-28 · branch `research/cf-tunnel-access-origin` (base `main`)

## Question

For **Pkg-D + Entry-P + Access-X**, what is the **recommended, source-backed** shape to run:

- `cloudflared` as a **Docker** service (official image / docs)
- Cloudflare **Tunnel** pointing at a **single** local origin
- Local **reverse proxy** (Caddy or nginx) terminating same-origin `/` → FE, `/api` + `/ws` → backend `:8000`
- **Cloudflare Access** allowlist in front of that hostname

Must answer:

1. Official/recommended way to supply tunnel token to the container; volume/env pitfalls.
2. Whether Access is configured entirely in Zero Trust dashboard vs needs app-side changes.
3. WebSocket considerations for platform `/ws` (node stays loopback-only — confirm no public need).
4. Minimal compose service sketch (names/env only) consistent with existing `platform/docker-compose.yml` keeping **db + rabbitmq**.
5. Risks for SPA + API cookie/auth if paths are wrong.

---

## Executive answer

| # | Answer |
|---|--------|
| **1. Token** | Prefer **`TUNNEL_TOKEN` env** (from host `.env` / secrets manager, not committed compose) or **`TUNNEL_TOKEN_FILE` / `--token-file`** (Docker secret / mounted file). Avoid `--token` on the container command line (`ps` / inspect leakage). Do **not** volume-mount a full `~/.cloudflared` tree unless using a **locally-managed** tunnel config. Use official image + `tunnel --no-autoupdate run`. |
| **2. Access** | **Allowlist + IdP policies are entirely Zero Trust dashboard** (self-hosted Access app on the public hostname). **No mandatory platform code change** for Access to gate the app. Optional hardening: enable tunnel **Protect with Access** (`cloudflared` validates `Cf-Access-Jwt-Assertion`) and/or origin JWT validation — recommended so a mis-exposed origin cannot bypass Access. App auth (Bearer JWT) remains separate. |
| **3. WebSocket** | Tunnel has **full WebSocket support**. Public browser clients need `/ws` through the **same** reverse-proxy hostname (WS upgrade). **Node4 must stay loopback** (`PLATFORM_WS_URL=ws://127.0.0.1:8000/ws` default) — **no public/tunnel route for node**. Reverse proxy must pass `Upgrade`/`Connection` for `/ws`. |
| **4. Compose** | Keep **`db` + `rabbitmq`**. Add optional **`cloudflared`** (+ optional **`proxy`** if reverse proxy is Docker per Pkg-D). **Do not** put backend/frontend/node4 in Docker for the beta shape (host processes). Tunnel public hostname → **one** proxy origin (host gateway), not raw backend. |
| **5. SPA/auth risks** | FE already uses **relative `/api`** (same-origin friendly). Prod WS must **not** keep defaulting to `http://localhost:8000`. Split FE/API hostnames break Access cookie scope + CORS. Wrong proxy paths → SPA shell on API routes, broken WS, or CORS hits (`allow_origins` is localhost-only today). Access `CF_Authorization` cookie ≠ app `access_token` in `localStorage`. |

**One sentence:** Internet → **CF Access** → **Tunnel** → **Docker `cloudflared`** → **one local reverse proxy** (same-origin `/` + `/api` + `/ws`) → host FE/backend; **Node4 loopback only**; token via env/file secret; Access dashboard owns the allowlist.

---

## Charting locks (honored, not edited)

From map **#151** (consulted only):

| Lock | Meaning for this research |
|------|---------------------------|
| **Pkg-D** | Docker: Postgres, RabbitMQ, **cloudflared**; **optional** reverse proxy in Docker. **Host processes:** backend, frontend, node4. pen-sandbox uses host Docker socket (out of scope here). |
| **Entry-P** | Internet → CF Tunnel → **one** local reverse proxy → same-origin `/` (FE) + `/api` + `/ws` (backend `:8000`). **Node loopback only.** |
| **Access-X** | Cloudflare Access **allowlist** in front of the app hostname. |

---

## Target topology

```text
                    Cloudflare edge
  Browser ──HTTPS──► Access (allowlist / IdP)
                         │
                         ▼
                    CF Tunnel (public hostname)
                         │
                         ▼
              cloudflared (Docker, outbound-only)
                         │
                         ▼
         reverse proxy (host or optional Docker)
           ├─ /        → FE static (host; Vite prod build or static server)
           ├─ /api/*   → http://127.0.0.1:8000
           └─ /ws      → http://127.0.0.1:8000  (WebSocket upgrade)

  Node4 (host) ──ws://127.0.0.1:8000/ws──► backend   (never via Tunnel)
  Backend (host) ──TCP──► db / rabbitmq (Docker published ports or docker network via host)
```

**Single public origin:** one hostname, one Access application covering the whole app path space (or `/*`). Do **not** publish separate public hostnames for API vs SPA in the default shape.

---

## 1. Tunnel token → container (official)

### 1.1 Primary sources

| Source | What it says |
|--------|----------------|
| [Tunnel run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/) | `cloudflared tunnel run --token <TUNNEL_TOKEN>` ↔ env **`TUNNEL_TOKEN`**. Also **`--token-file <PATH>`** ↔ **`TUNNEL_TOKEN_FILE`**. |
| Same page | Docker/containers: **`--no-autoupdate`** / `NO_AUTOUPDATE` — disable auto self-update (image tag is the update path). |
| [cloudflare/cloudflared Docker Hub](https://hub.docker.com/r/cloudflare/cloudflared) | Official image; real usage: create tunnel in Zero Trust dashboard, run the provided **single-line** container command with account auth (token-based remotely managed tunnel). |
| Community / ops consensus (compose threads) | Prefer **env `TUNNEL_TOKEN`** over CLI `--token` so the token is not visible in process argv; better still: file secret + `token-file`. |

### 1.2 Recommended supply methods (ordered)

1. **Best for Docker Compose secrets / Swarm / K8s-style mounts:**  
   Mount secret file → `TUNNEL_TOKEN_FILE=/run/secrets/tunnel_token`  
   or `command: tunnel --no-autoupdate run --token-file /run/secrets/tunnel_token`
2. **Good default for single-host beta:**  
   `environment: TUNNEL_TOKEN: ${TUNNEL_TOKEN}` with value only in **host `.env`** (gitignored) or deploy secrets — never in committed YAML.
3. **Acceptable but weaker:**  
   `command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}` — works (dashboard copy-paste style) but argv may appear in `docker inspect` / process listings.

### 1.3 Pitfalls

| Pitfall | Why it hurts |
|---------|----------------|
| Token in committed `docker-compose.yml` / git | Credential leak; rotate tunnel token immediately if ever committed. |
| CLI `--token ...` as sole secret surface | Visible to local users via process list / inspect. |
| Mounting `~/.cloudflared` for **remotely managed** token tunnels | Wrong model: remote tunnels do not need local `cert.pem` + config.yml for the common dashboard-token path; confused mounts break startup. |
| Locally managed tunnel without understanding credentials JSON | Local management needs config + credentials file; beta default should be **remotely managed** tunnel (dashboard public hostname routes). |
| Missing `host` reachability from container | If proxy listens on host loopback only, containerized cloudflared must use **`host.docker.internal`**, host gateway IP, or **`network_mode: host`** (Linux) — not `localhost` inside the container namespace. |
| Pointing tunnel **directly** at backend `:8000` | Violates Entry-P same-origin FE+API; SPA static not served; CORS/cookie pain. |
| Enabling tunnel auto-update inside immutable image | Prefer pin image tag + `--no-autoupdate`; roll via compose pull. |
| Exposing db/rabbitmq ports on the public internet | Compose today publishes `5432`/`5672`/`15672` for lab convenience — **beta host firewall must not expose these**; only Tunnel origin (proxy) is public path. |

---

## 2. Cloudflare Access: dashboard vs app-side

### 2.1 What is dashboard-only (Access-X core)

From [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/):

1. Zero Trust → **Access controls → Applications** → Self-hosted.
2. Bind **public hostname** (the Tunnel published hostname).
3. Attach **Allow** policies (email allowlist, IdP group, etc.). Default deny.
4. Choose IdPs / session duration / optional cookie & CORS settings.
5. Connect origin via **Cloudflare Tunnel** so only Access-passed traffic reaches `cloudflared`.

That is sufficient for **Access-X allowlist in front of the app**. Users hit Access login (or instant IdP) **before** the SPA loads. No change to FastAPI routes is required for that gate to work.

### 2.2 Optional origin-side hardening (recommended, not product identity)

Same docs § “Validate the Access token”:

- Requests that **bypass** Access (misconfiguration / direct origin exposure) should be rejected.
- **Option A (preferred with Tunnel):** enable **Protect with Access** on the tunnel public hostname so `cloudflared` validates the Access JWT (`Cf-Access-Jwt-Assertion`) before proxying — see [Origin parameters → access](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).
- **Option B:** application validates Access JWT itself ([validating JSON](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).

**For this repo:** platform auth is **app JWT Bearer** (`Authorization` + `localStorage` `access_token`), independent of Access. Access is an **outer perimeter allowlist**, not a replacement for app login. **No mandatory app-side Access integration** for beta; optional Protect-with-Access on the tunnel is the low-code hardening path.

### 2.3 When app-side *would* matter

| Situation | Need |
|-----------|------|
| Same-origin SPA + API under one Access app | Usually **none** beyond dashboard |
| API on **another** hostname | Access CORS settings + cookie domain pain — **avoid** (Entry-P) |
| Machine-to-machine through public hostname | Access **service tokens** (`CF-Access-Client-Id/Secret`) — not needed for Node4 if node is loopback |
| Want Access identity inside app ACLs | Consume Access JWT claims — **out of scope** for Access-X |

---

## 3. WebSocket: platform `/ws` and Node loopback

### 3.1 Cloudflare support

| Source | Fact |
|--------|------|
| [Tunnels FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) | “Does Cloudflare Tunnel support Websockets? **Yes.** Full support.” |
| [Network → WebSockets](https://developers.cloudflare.com/network/websockets/) | Proxied WebSockets supported; zone Network toggle; idle timeout exists — implement keepalive/reconnect. |

### 3.2 Repo surfaces

| Client | Path | Default / config |
|--------|------|------------------|
| **Browser FE** | `/ws?token=<app JWT>` | [`platform/frontend/src/hooks/useWebSocket.ts`](../../platform/frontend/src/hooks/useWebSocket.ts): `VITE_WS_URL` or `VITE_BACKEND_URL` → replace `http`→`ws`, default **`http://localhost:8000`**. |
| **Node4** | same backend `/ws` | [`node4/src/config.ts`](../../node4/src/config.ts): `PLATFORM_WS_URL` default **`ws://localhost:8000/ws`**. |
| **Backend** | `@router.websocket("/ws")` | [`platform/backend/app/ws/router.py`](../../platform/backend/app/ws/router.py) — mounted on app root, not under `/api`. |

### 3.3 Entry-P implications

1. **Public browser path:** `wss://<public-host>/ws` via reverse proxy upgrade to backend `:8000`. Same Access session cookie domain as `/` and `/api` (browser sends `CF_Authorization` on the WS upgrade request for that host).
2. **Node path:** **loopback only.** Node4 must **not** use the public Tunnel URL. Charting lock + product security: node token + WS stay on the host network. Confirm: **no public need** for node connectivity; publishing node WS would expand attack surface and fight Access (service auth complexity).
3. **Proxy requirements:** pass WebSocket upgrade headers for `/ws` (Caddy/`reverse_proxy` default usually OK; nginx needs explicit `Upgrade` / `Connection` / long `proxy_read_timeout`).
4. **Idle / reconnect:** FE already reconnects with backoff; Cloudflare may drop idle sockets — keep that behavior; do not special-case CF in app code for beta.

### 3.4 Prod FE gap (call out, do not implement here)

Dev proxy only maps **`/api`** ([`vite.config.ts`](../../platform/frontend/vite.config.ts)); **`/ws` is not proxied in Vite**. Browser WS uses absolute backend URL. For Entry-P production:

- Prefer deriving WS URL from **`window.location`** (`wss:` + same host + `/ws`) when `VITE_WS_URL` unset, **or**
- Set `VITE_WS_URL=wss://<public-host>` / empty same-origin helper at build time.

Leaving absolute `localhost:8000` in a tunnel-facing build **breaks** remote browsers even if Tunnel is perfect.

---

## 4. Minimal compose sketch (names / env only)

Existing truth: [`platform/docker-compose.yml`](../../platform/docker-compose.yml) today has **`db`**, **`rabbitmq`**, and a **`backend`** service (build + port 8000). **Pkg-D / Entry-P target** moves backend to **host**; keep **db + rabbitmq** in compose; add **cloudflared** (and optional **proxy**).

Sketch (illustrative — not a product PR):

```yaml
# platform/docker-compose.yml (target shape — names/env only)
services:
  db:
    image: postgres:16-alpine
    # existing POSTGRES_* + volume pgdata
    # beta: prefer bind 127.0.0.1:5432 or no host publish if backend on docker network

  rabbitmq:
    image: rabbitmq:3-management-alpine
    # existing AMQP ports; do not expose management UI publicly

  # OPTIONAL if reverse proxy runs in Docker (Pkg-D allows host OR Docker proxy)
  # proxy:
  #   image: caddy:2-alpine   # or nginx:alpine
  #   ports: ["127.0.0.1:8080:80"]   # only loopback / docker network
  #   # config: / → host FE, /api|/ws → host.docker.internal:8000

  cloudflared:
    image: cloudflare/cloudflared:latest   # pin digest/tag in real deploy
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}          # from host env / secrets — not committed
      # alternative:
      # TUNNEL_TOKEN_FILE: /run/secrets/tunnel_token
    # network_mode: host   # simplest path to host proxy on :8080 / FE
    # or extra_hosts: ["host.docker.internal:host-gateway"]
    depends_on: []   # tunnel is independent of db/rabbitmq health

volumes:
  pgdata:
```

**Dashboard tunnel public hostname service URL (remote config):**

```text
http://127.0.0.1:<proxy-port>     # if cloudflared uses host network
# or http://host.docker.internal:<proxy-port>
```

**Not** `http://backend:8000` for the public route when FE must share origin.

**Host processes (not in compose per Pkg-D):**

| Process | Bind / env |
|---------|------------|
| Backend | `uvicorn ... --host 127.0.0.1 --port 8000` (prefer loopback if only proxy+node need it) |
| Frontend | static server or `vite preview` on loopback; proxy `/` → that port |
| Node4 | `PLATFORM_WS_URL=ws://127.0.0.1:8000/ws`, `NODE_TOKEN=...` |

**What stays Docker-only for data plane:** Postgres + RabbitMQ (as today). Backend’s `DATABASE_URL` / `RABBITMQ_URL` on host point at `localhost:5432` / `localhost:5672` (current published ports).

---

## 5. SPA + API cookie / auth risks if paths are wrong

### 5.1 How this app authenticates today

| Layer | Mechanism | Source |
|-------|-----------|--------|
| **App API** | `Authorization: Bearer <access_token>`; token in **`localStorage`** | [`platform/frontend/src/lib/api.ts`](../../platform/frontend/src/lib/api.ts), [`authStore.ts`](../../platform/frontend/src/stores/authStore.ts) |
| **App API base** | Relative **`/api`** (`BASE = "/api"`) | `api.ts` — **already same-origin oriented** |
| **App WS** | Query `?token=` with same access token | `useWebSocket.ts` |
| **CORS** | `allow_origins=["http://localhost:5173"]`, `allow_credentials=True` | [`platform/backend/app/main.py`](../../platform/backend/app/main.py) |
| **Access (edge)** | `CF_Authorization` cookie (HttpOnly) after IdP | Cloudflare Access — **orthogonal** to app JWT |

### 5.2 Failure modes

| Misconfig | Symptom | Why |
|-----------|---------|-----|
| Tunnel → backend only (no FE) | Blank or API JSON at `/` | Entry-P violated; SPA not served |
| Proxy missing `/api` → backend | Login/API 404 HTML from SPA fallback | Paths wrong |
| Proxy missing `/ws` upgrade | Chat/live updates dead | WS not terminated correctly |
| FE build still uses `localhost:8000` for WS/API | Works on server laptop only | Absolute URLs ignore public host |
| Separate `app.` and `api.` hostnames | Access login thrash, CORS preflight fails, missing `CF_Authorization` on XHR | Cookie host-scoped; Access CORS complexity |
| Access **Cookie Path** enabled with narrow path | `/api` or `/ws` not covered after login at `/` | Access cookie path attribute |
| Relying on CORS for cross-origin prod | Browser blocked; credentials issues | Backend allowlist is **localhost:5173 only** — same-origin proxy is the fix, not expanding CORS casually |
| Exposing backend `:8000` on `0.0.0.0` publicly **and** Tunnel | Access bypass if attacker hits IP:port | Bind loopback + firewall; optional Protect with Access |
| Putting Node through public host | Access blocks or requires service token; security smell | Keep loopback (Entry-P) |
| Confusing Access session expiry with app JWT expiry | User “logged in” to Access but app 401s (or reverse) | Two independent sessions |

### 5.3 Why same-origin is the low-risk default

- Relative `/api` already matches Entry-P.
- One Access application covers SPA + API + browser WS with one `CF_Authorization` cookie domain.
- Avoids Access CORS configuration entirely for first-party browser traffic.
- App Bearer tokens never need to be stuffed into Access headers.

### 5.4 Reverse proxy checklist (Caddy/nginx)

- `/` → FE assets (SPA `try_files` / `try_files $uri /index.html` for client routes).
- `/api/` → backend HTTP (preserve path prefix — backend routes are `/api/...`).
- `/ws` → backend with WebSocket support (path is exactly `/ws`, not under `/api`).
- Do **not** strip `/api` prefix unless backend is reconfigured (it is not).
- TLS termination at Cloudflare edge; origin to proxy can be HTTP on loopback.

---

## Repo evidence summary

| Path | Relevance |
|------|-----------|
| `platform/docker-compose.yml` | Today: `db`, `rabbitmq`, `backend`. Target beta: keep data services; add `cloudflared`; host BE/FE per Pkg-D. |
| `platform/frontend/src/lib/api.ts` | `BASE = "/api"` relative fetch — same-origin ready. |
| `platform/frontend/vite.config.ts` | Dev proxy `/api` only; default `VITE_BACKEND_URL=http://localhost:8000`. |
| `platform/frontend/src/hooks/useWebSocket.ts` | Absolute WS base from env/localhost — prod must be same-host. |
| `platform/backend/app/main.py` | CORS localhost:5173; mounts API + WS routers. |
| `platform/backend/app/ws/router.py` | `/ws` endpoint. |
| `node4/src/config.ts` | Default `ws://localhost:8000/ws` — correct for loopback-only node. |

---

## Recommended shape (decision table)

| Concern | Recommendation |
|---------|----------------|
| Tunnel management | **Remotely managed** tunnel; public hostname → **single proxy** origin |
| cloudflared packaging | Official **`cloudflare/cloudflared`** image; Docker service; pin tag |
| Token | **`TUNNEL_TOKEN` from secret env** or **`TUNNEL_TOKEN_FILE`**; never commit |
| Access | Dashboard self-hosted app + allowlist; optional **Protect with Access** on tunnel |
| App code for Access | **Not required** for Access-X allowlist |
| Public paths | `/`, `/api/*`, `/ws` only via one hostname |
| Node | **Loopback WS only**; no Tunnel route |
| Compose | **db + rabbitmq + cloudflared** (+ optional proxy); host BE/FE/node4 |
| FE prod WS | Same-origin `wss` (follow-up if not already fixed when wiring deploy) |

---

## Out of scope / non-goals

- Implementing compose/proxy configs or CD wiring (map #151 later tickets).
- Replacing app login with Access-only identity.
- WARP / private network mode (this research is **published hostname + Access**).
- Editing map **#151** body.
- Exposing pen-sandbox or RabbitMQ management through Tunnel.

---

## Primary source index

1. https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/ — `TUNNEL_TOKEN`, `TUNNEL_TOKEN_FILE`, `no-autoupdate`
2. https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ — Access app + tunnel + optional JWT validation
3. https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/ — Protect with Access (`originRequest.access`)
4. https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/ — WebSocket support yes
5. https://developers.cloudflare.com/network/websockets/ — edge WebSockets, idle timeout
6. https://hub.docker.com/r/cloudflare/cloudflared — official image / dashboard install command pattern
7. https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/ — `CF_Authorization` cookie behavior
8. Repo: `platform/docker-compose.yml`, FE `api.ts` / `useWebSocket.ts` / `vite.config.ts`, BE `main.py` / `ws/router.py`, `node4/src/config.ts`

---

## Resolution

This note answers #226 for map #151 charting locks. Implementation belongs in a later deploy/package ticket; this branch carries **docs only**.
