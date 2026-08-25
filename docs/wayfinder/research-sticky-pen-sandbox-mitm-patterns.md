# Research: sticky pen-sandbox + MITM proxy patterns (env proxy vs transparent)

**Date:** 2026-08-21  
**Ticket:** wayfinder research [#445](https://github.com/zangjiaao/my-ai-pen/issues/445)  
**Map:** [#442](https://github.com/zangjiaao/my-ai-pen/issues/442) (Passive pen-sandbox egress MITM → Case Traffic, job D)  
**Scope:** Durable **facts** (not product decisions) for putting a decrypting HTTP(S) observer on a **long-lived Docker seat** like sticky pen-sandbox.  
**Does not implement product code. Does not choose a product path.**

**Related living docs (product truth, not this note’s authority for MITM):**  
- `docs/specs/pen-tools-sandbox.md` — Session-sticky pen-sandbox  
- `docs/specs/traffic-audit-activity.md` — Case Traffic; V1 job A hooks; **future job D** full MITM reserved  
- Sticky Spec [#426](https://github.com/zangjiaao/my-ai-pen/issues/426) (shipped)

**Frozen third-party (patterns as facts about that tree, not merge):** `research/anything-analyzer/` (`src/main/proxy/`, capture engine).

---

## Question

What are durable facts for a decrypting HTTP(S) observer on a long-lived Docker seat (sticky pen-sandbox): sidecar vs in-box process; explicit `HTTP(S)_PROXY` + CA vs transparent REDIRECT/TPROXY; which in-image tools honor env proxy; CA install surfaces; failure modes a Spec must name honestly?

---

## Executive answer (facts)

| Dimension | As documented / as code today |
|-----------|-------------------------------|
| Sticky seat | One long-lived Docker box per `(conversationId, expertId)`; default `--network host`; `sleep infinity`; `docker exec` for shell + `agent-browser`; idle **stop** / seat **rm** |
| Image | `kalilinux/kali-rolling` + `ca-certificates`, `curl`, `wget`, `nmap`, `nuclei`, `sqlmap`, `ffuf`, `python3`, `gobuster`, `httpx-toolkit`, `agent-browser` + Playwright Chromium cache |
| Current Traffic | Runtime hooks: `http` tool + browser network + **best-effort shell curl/wget/httpie**. Type already reserves `source: mitm`. nuclei / python / non-curl shell **are not** hook-captured |
| Regular proxy | mitmproxy’s **recommended / most robust** mode: client configured to use HTTP(S) proxy (default listen `:8080`) + trust mitmproxy CA |
| Transparent | iptables **REDIRECT** (or pf) of dest 80/443 → proxy; client is unaware; **same CA trust still required** for HTTPS decrypt. Local-origin traffic needs **OUTPUT** rules and a **uid-owner exception** to avoid loops |
| Env-proxy coverage | curl, wget, Python Requests (unless `trust_env=False`) honor env. sqlmap honors “system default proxy” unless `--ignore-proxy`. nuclei/ffuf document **CLI flags**, not env. nmap `--proxies` does **not** cover SYN/portscan and **does not support SSL**. Chromium does **not** treat `HTTP_PROXY` like curl |
| CA | Debian-class `update-ca-certificates` feeds OpenSSL/`curl`/`wget` and Go’s Linux system pool (`/etc/ssl/certs/ca-certificates.crt`). Python Requests uses **certifi**, not that file, unless `REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE`. Chrome/Chromium uses **Chrome Root Store** + extra policy/NSS surfaces — **not** guaranteed to pick up OS CA |
| Failures that exist regardless of product choice | Certificate pinning; HTTP/2/3 limits; QUIC/HTTP3 not on regular HTTP CONNECT; concurrency vs body buffering; same-netns redirect loops; `--network host` shares the **host** namespace across seats; agents can unset env or `--noproxy`; `docker stop` kills in-box processes |

---

## 0. Product-code anchors (what the seat actually is)

These are facts about **this repo today**, not MITM design.

### 0.1 One sticky box, host net, extra caps

`BrowserSandboxRuntime.ensure` creates the seat with default **host** network, `NO_PROXY` for loopback, `HOME=/root`, Playwright cache on rootfs, `sleep infinity` (`node4/src/runtime/browser-sandbox-runtime.ts` ~308–327):

```text
env: NO_PROXY/no_proxy=localhost,127.0.0.1,host.docker.internal
     AGENT_BROWSER_SESSION=…
     HOME=/root
     PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
network: PEN_TOOLS_NETWORK || "host"
entrypoint: bash -lc "sleep infinity"
```

Docker create also always adds (`node4/src/runtime/browser-sandbox-docker.ts` 131–145):

- `--network` (same default `"host"`)
- `--add-host host.docker.internal:host-gateway`
- `--cap-add NET_ADMIN`
- `--cap-add NET_RAW`

**Fact:** the seat already has `NET_ADMIN`/`NET_RAW`. Those caps are sufficient on Linux for in-namespace iptables REDIRECT (iptables needs `CAP_NET_ADMIN`). They are **not** a product MITM implementation.

**Fact:** Docker **host** network means the container **shares the host network namespace** and **does not get its own IP** ([Docker host network driver](https://docs.docker.com/engine/network/drivers/host/)). Port mapping is ignored. Every sticky seat with default `PEN_TOOLS_NETWORK=host` shares **one** host netns with the Docker host **and with every other host-net seat**.

**Fact:** `docker exec` injects only `PEN_SANDBOX_HOME_ENV` (`HOME`, `PLAYWRIGHT_BROWSERS_PATH`) — not `HTTP_PROXY` (`browser-sandbox-docker.ts` 163–173). Processes inherit **container** env from `docker run -e` (today: `NO_PROXY`, session name, HOME). An agent command can still `unset HTTP_PROXY` or pass `--noproxy '*'` inside that bash.

### 0.2 Image contents (Kali-class, Debian-family CA tooling)

`sandbox/pen-sandbox/Dockerfile`:

- `FROM kalilinux/kali-rolling:latest`
- `apt-get install … ca-certificates curl wget nmap … httpx-toolkit gobuster nuclei sqlmap ffuf … python3 python3-pip … libnss3 libnspr4 …`
- `npm install -g agent-browser@0.11.0 && agent-browser install`
- `CMD ["bash", "-lc", "sleep infinity"]`

Kali ships Debian’s `ca-certificates` package ([pkg.kali.org `ca-certificates`](https://pkg.kali.org/pkg/ca-certificates)). The Debian manpage contract applies: local CAs as `*.crt` under `/usr/local/share/ca-certificates`, then `update-ca-certificates` writes `/etc/ssl/certs` and `/etc/ssl/certs/ca-certificates.crt` ([update-ca-certificates(8)](https://manpages.debian.org/bookworm/ca-certificates/update-ca-certificates.8.en.html)).

`agent-browser install` plus `PLAYWRIGHT_BROWSERS_PATH` means the browser is **Playwright’s Chromium/Chrome-for-Testing**, not a separately packaged `google-chrome` binary in the Dockerfile.

### 0.3 Lifecycle vs an in-box observer

Living spec (`docs/specs/pen-tools-sandbox.md` §4): idle **4h** → `docker stop` (not rm); Session/Case dispose → `docker rm -f`; Node shutdown → stop all. `docker stop` signals PID 1 (`sleep infinity`) and then kills remaining processes in that container.

**Fact:** an **in-box** mitmdump dies on idle stop and must be started again on `docker start` + exec. A **sidecar** container has its own PID 1 / stop clock unless the product ties it to the same seat labels.

### 0.4 What Traffic collects today

`docs/specs/traffic-audit-activity.md`: V1 = job **A** fact-bypass (`http` + browser network + best-effort **shell curl/wget/httpie**). Future job **D** full MITM reuses the same exchange shape + new `source`. `source` logical values: `http | browser | shell (| future mitm)`. Out of V1: intercept/edit/replay, full MITM.

Code: `TrafficSource = "http" | "browser" | "shell" | "mitm"` (`node4/src/runtime/traffic-collect.ts` 22). Shell HTTP parse is gated on `curl|wget|http(ie)` with an absolute URL (same file ~576–591). nuclei / python / ffuf / nmap-http are **not** in that regex.

Map #442 notes: host `http` tool stays Node fetch (not sandbox); nuclei / python / non-curl shell miss Traffic.

---

## 1. mitmproxy / mitmdump: sidecar same-network vs in-box process

Primary: [mitmproxy Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/), [Transparent Proxying](https://docs.mitmproxy.org/stable/howto/transparent/), [Certificates](https://docs.mitmproxy.org/stable/concepts/certificates/), [official Docker image](https://hub.docker.com/r/mitmproxy/mitmproxy/).

### 1.1 What mitmproxy is

- Tools: `mitmproxy` (TUI), `mitmdump` (non-interactive), `mitmweb`. **Any mode works with any tool.**
- Official Docker image listens as an **HTTP proxy on `:8080`**. Docs show clients using `http_proxy`/`https_proxy`. Volume `~/.mitmproxy` is required to **persist the CA** across container restarts — without it, “a new root CA would be generated on each container restart.”
- Decrypt requires the **client to trust mitmproxy’s CA**. First start writes `~/.mitmproxy/mitmproxy-ca.pem` (key+cert) and `mitmproxy-ca-cert.pem` (cert only).

### 1.2 Modes that matter for a seat box

| Mode | Client awareness | Setup | Notes from docs |
|------|------------------|-------|-----------------|
| **Regular** (default) | Client must use HTTP(S) proxy | “Simplest and the most robust.” Listen 8080 | Apps that **bypass** OS proxy need another mode |
| **Transparent** | Client unaware | iptables/pf REDIRECT 80/443 → 8080; `--mode transparent`; **still install CA** | “Ideal when you can’t change client behaviour” |
| **Local capture** | Transparent via eBPF | `--mode local` / `local:curl` | Linux: egress only; needs **sudo/BPF**, kernel **6.8+**; **WSL unsupported**; **containers fail unless `--network host`** |
| **TUN** | Virtual iface | `--mode tun` | Needs root/`CAP_NET_ADMIN`; official image **drops privileges** — docs show `--privileged --network host` |
| **SOCKS** | SOCKS5 client | `--mode socks5` | Useful if a tool speaks SOCKS not HTTP CONNECT |
| **WireGuard** | VPN client | `--mode wireguard` | Not a Docker-seat pattern unless the box is a WG peer |
| **Reverse** | Clients hit the proxy as origin | `--mode reverse:…` | Wrong shape for “observe seat egress” |

### 1.3 In-box process (mitmdump inside the sticky container)

**Network fact under default host net:** binding `:8080` inside the seat **is binding the Docker host’s 8080**. All host-net seats compete for that port. A second seat cannot also listen on 8080.

**Lifecycle fact:** process is a child of the sticky PID 1. `docker stop` / `docker rm` tear it down. Idle-stop then later `docker start` does **not** restart non-PID-1 daemons unless something execs them again.

**Filesystem fact:** CA files can live on container rootfs (`~/.mitmproxy` under `HOME=/root`) — they survive **stop/start** of the same container, and die on **rm**. They are **not** on `/workspace` unless explicitly placed there. Spec #426 already calls audit proxy runtime **ephemeral-OK**.

**Loop fact (transparent, same box):** mitmproxy’s Linux transparent HOWTO says PREROUTING REDIRECT catches **forwarded** traffic, not locally originated. For traffic **from the machine itself**, they document OUTPUT REDIRECT **excluding** the uid that runs mitmproxy (`! --uid-owner mitmproxyuser`). Otherwise the proxy’s own upstream connects are redirected back into itself. In a single-user root box (`HOME=/root`, typical Docker), **uid-owner is a weak discriminator** — the scanners and the proxy are often both uid 0.

**Privilege fact:** in-box iptables needs `CAP_NET_ADMIN` (already granted). TUN mode additionally needs to create a tun device (privileged / device node). Local-capture eBPF needs a recent **host** kernel and sudo inside the container — often false on Docker Desktop / WSL.

### 1.4 Sidecar on the same network

Two concrete “same network” topologies, which are **not equivalent**:

| Topology | How packets move | Port collision | iptables where |
|----------|------------------|----------------|----------------|
| **A. Both `--network host`** | Sidecar and seat share **host netns** | Same as in-box: one listen port on the host | Host iptables = seat iptables |
| **B. User-defined bridge, both attached** | Each has its own netns + IP; DNS name = container name ([Docker container networking](https://docs.docker.com/engine/containers/run/)) | Sidecar can bind 8080 **inside its netns**; seat uses `http://sidecar:8080` | REDIRECT in the **seat** netns (or `DOCKER-USER` on host) — does not hit host 80/443 |

Official mitmproxy image usage is topology-agnostic: `docker run -p 8080:8080 -v ~/.mitmproxy:… mitmproxy/mitmproxy mitmdump`. `-p` is **discarded** if that sidecar is also `--network host`.

**WSL / Docker Desktop facts (from primary docs, not lab):**

- Docker host-net on Desktop is **opt-in**, **layer 4 only**, not equivalent to Linux host netns ([host network driver — Docker Desktop](https://docs.docker.com/engine/network/drivers/host/)).
- mitmproxy **local capture is unsupported on WSL** (eBPF disabled by default).
- Map #442 already lists “WSL / Docker Desktop networking quirks for sidecar vs in-box” as unspecified.

**CA persistence (sidecar):** official image: mount `~/.mitmproxy` or a new CA is generated every container recreate. Sticky seat **rm** does not automatically rm a separately named sidecar unless product labels/janitor say so.

### 1.5 What “same network” does **not** solve

HTTPS decrypt still needs the **client trust store** to contain the proxy CA in **both** regular and transparent modes ([Certificates](https://docs.mitmproxy.org/stable/concepts/certificates/)). Network placement only answers “can the TCP handshake reach the proxy.”

---

## 2. Explicit `HTTP(S)_PROXY` + preinstalled CA vs transparent REDIRECT/TPROXY

### 2.1 Regular / explicit proxy (CONNECT)

mitmproxy regular mode ([Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/)):

1. Start mitmproxy/mitmdump (no extra flags).
2. Configure the client **explicitly** as an HTTP proxy (default port 8080).
3. HTTP works immediately; HTTPS needs CA install (`mitm.it` or `--cacert` / trust store).
4. Topology: client TCP-connects **to the proxy**; proxy TCP-connects **to the target**. Absolute-form HTTP or `CONNECT host:443` then TLS to the **forged** cert.

Environment-variable shape (de facto, not an IETF standard — see curl’s CGI warning below):

| Variable | Typical meaning |
|----------|-----------------|
| `http_proxy` | Proxy URL for `http://` targets |
| `https_proxy` / `HTTPS_PROXY` | Proxy URL for `https://` targets (usually still an **http://** proxy that speaks CONNECT) |
| `ALL_PROXY` | Fallback for other schemes (curl; Requests) |
| `NO_PROXY` / `no_proxy` | Hosts that must not use the proxy |

**curl-specific:** `http_proxy` is **lowercase only**, because CGI maps request header `Proxy` → env `HTTP_PROXY` ([everything curl — proxy env](https://everything.curl.dev/usingcurl/proxies/env.html)). Other scheme vars accept uppercase.

Seat already sets `NO_PROXY=localhost,127.0.0.1,host.docker.internal` at create. That is **exactly** the exclusion list a proxy client would skip — relevant if Node later injects `HTTP_PROXY` without expanding `NO_PROXY`.

**Honest gap:** there is no single POSIX spec that all tools implement identically (GitLab engineering writeup on `NO_PROXY` fragmentation is widely cited; not used here as a product requirement).

### 2.2 Transparent REDIRECT vs TPROXY

mitmproxy Linux transparent HOWTO uses **iptables NAT REDIRECT**, not TPROXY:

```text
iptables -t nat -A PREROUTING -i eth0 -p tcp --dport 80  -j REDIRECT --to-port 8080
iptables -t nat -A PREROUTING -i eth0 -p tcp --dport 443 -j REDIRECT --to-port 8080
mitmproxy --mode transparent --showhost
```

**REDIRECT (NAT):** destination address rewritten to the proxy’s local port. Original destination is recovered by the proxy via `SO_ORIGINAL_DST` (Linux). Client TCP stack thinks it connected to the **real** IP:443. No `HTTP_PROXY`. TLS SNI still names the real host; mitmproxy sniffs upstream cert and forges a leaf ([Certificates — upstream cert sniffing](https://docs.mitmproxy.org/stable/concepts/certificates/)).

**TPROXY (mangle, not in mitmproxy’s default HOWTO):** preserves original dest IP:port on the socket; requires policy routing + `CAP_NET_ADMIN`. Some transparent proxies prefer it so the proxy can see the original dest without `SO_ORIGINAL_DST`. **Not verified here that mitmproxy’s `--mode transparent` uses TPROXY** — the published HOWTO is REDIRECT.

**Local-origin workaround** (same HOWTO): OUTPUT chain, exclude proxy uid. On a root-only pen-sandbox this is the loop hazard in §1.3.

**IPv6:** HOWTO dual-runs `ip6tables`. Host-net seats that speak IPv6 to dual-stack targets bypass IPv4-only REDIRECT.

**Non-80/443 HTTP:** REDIRECT of only 80/443 **misses** HTTP on 8080/8443/3000/etc. Regular proxy does not have that port filter — CONNECT is to whatever port the URL named.

### 2.3 Comparison (facts, not a pick)

| | Explicit env + CA | Transparent REDIRECT + CA |
|--|-------------------|---------------------------|
| Client must opt in | Yes (env/flag). Tools that ignore env **miss** | No for TCP/80/443 |
| Tools that ignore proxy env | **Blind** | Captured **if** they use TCP 80/443 and don’t pin |
| nmap SYN / redis / non-HTTP | Not HTTP CONNECT | Not HTTP — proxy sees raw TCP only if redirected; mitmproxy HTTP mode will not decode redis |
| Loopback / `NO_PROXY` | Honored by env-aware clients (seat already excludes localhost) | OUTPUT REDIRECT can still catch localhost unless excluded |
| Agent can bypass | `unset HTTP_PROXY`, `--noproxy`, `trust_env=False`, `--ignore-proxy` | Need raw sockets / alternate ports / UDP/QUIC |
| Same-netns loop | No (client talks to proxy; proxy talks out) | Yes unless uid/mark exclude |
| `--network host` multi-seat | Need **per-seat proxy port** or clients will share one proxy | iptables on host netns is **global** unless marked per-cgroup |

---

## 3. Tool coverage table (pen-sandbox image)

Columns:

- **Env proxy?** honors `http_proxy`/`https_proxy` (or documented equivalent) without extra flags  
- **CLI proxy?** documented flag  
- **Transparent needed?** “yes” = env/flag **not** sufficient for typical use; “if ignore env” = env works unless the invocation opts out  
- **CA store** that must trust the MITM CA for **decrypt** (HTTPS)

| Tool in image | Env proxy honors? | Documented CLI proxy | Transparent needed? | CA / TLS store | Primary source |
|---------------|-------------------|----------------------|---------------------|----------------|----------------|
| **curl** | **Yes** (`http_proxy`; `https_proxy`/`HTTPS_PROXY`; `ALL_PROXY`; `NO_PROXY`) | `-x` / `--proxy`; `--cacert`; `--noproxy` | No if env set | OpenSSL system store **or** `--cacert` | [everything curl — env](https://everything.curl.dev/usingcurl/proxies/env.html); [mitmproxy certs curl example](https://docs.mitmproxy.org/stable/concepts/certificates/) |
| **wget** | **Yes** (`http_proxy`, `https_proxy`, `no_proxy`) | `--no-proxy`; `.wgetrc` | No if env set | System / `--ca-certificate` | [GNU Wget 1.25 Proxies](https://www.gnu.org/software/wget/manual/html_node/Proxies.html); mitmproxy wget example |
| **python3 + Requests** | **Yes** by default (`http_proxy`, `https_proxy`, `no_proxy`, `all_proxy`, uppercase too). `Session.trust_env = False` **ignores** env | `proxies=` dict | If script sets `trust_env=False` or raw `socket`/`http.client` without env | **certifi bundle**, not Debian store, unless `REQUESTS_CA_BUNDLE` or `CURL_CA_BUNDLE` | [Requests Advanced — Proxies](https://requests.readthedocs.io/en/latest/user/advanced/); [SSL cert verification](https://requests.readthedocs.io/en/latest/user/advanced/#ssl-cert-verification) |
| **python3 urllib** | Env via `ProxyHandler` (stdlib); CGI/`HTTP_PROXY` caveats exist | n/a | If opener disables proxy | System OpenSSL / ssl context | stdlib behavior; curl CGI note analog |
| **nuclei** | **Not documented** as env. Official flags: `-p/-proxy` (http/socks5), `-pi/-proxy-internal` | **Yes** | For default `nuclei -u …` **without** `-proxy`: **yes** (or product must inject argv) | Go `crypto/x509` system pool on Linux (see §4.2). `-proxy` still needs that pool to trust MITM CA | [ProjectDiscovery Running Nuclei](https://docs.projectdiscovery.io/opensource/nuclei/running) |
| **ffuf** | **Not documented** as env | `-x` “Proxy URL (SOCKS5 or HTTP)” e.g. `http://127.0.0.1:8080`; `-replay-proxy` is **matches only**, not all traffic | Default `ffuf -u https://…` without `-x`: **yes** | Go system pool | [ffuf README Usage](https://github.com/ffuf/ffuf) (`-x`) |
| **sqlmap** | Documented **system default proxy**; `--ignore-proxy` turns it off | `--proxy`, `--proxy-cred`, `--proxy-file` | If `--ignore-proxy` or no system proxy: **yes** | Python TLS (sqlmap is Python; not separately verified vs certifi vs system in this note) | [sqlmap wiki Usage](https://github.com/sqlmapproject/sqlmap/wiki/Usage) |
| **nmap** (portscan / `-sS` / `-sV` / NSE http) | **No** general env. `--proxies` is **nsock only** | `--proxies` HTTP or SOCKS4 | **Yes** for almost all scans. `--proxies` **does not** affect ping, port scan, OS detect; **SSL connections not supported**; hostnames resolved by nmap | N/A for SYN; NSE TLS is **not** proxy-capable per man page | [Nmap man — Firewall/IDS](https://nmap.org/book/man-bypass-firewalls-ids.html) (`--proxies` warning) |
| **httpx-toolkit** | Env **not verified** from ProjectDiscovery primary docs in this pass (a later httpx change titled “honor HTTP_PROXY…” exists as CI noise — treat env as **unverified**) | httpx historically has `-http-proxy` (not re-read as a manpage here) | Treat default as **likely needs flag or transparent** until verified | Go system pool (typical) | **Unverified** — say so |
| **gobuster** | **Unverified** | Common `-p/--proxy` in gobuster help **not fetched** this pass | Unverified | Go system pool (typical) | **Unverified** |
| **whatweb / httpx-toolkit / gobuster** as a class | Many Go/Ruby scanners **do not** document env proxy | Tool-specific | Default assume **transparent or argv injection** | Varies | Honest gap |
| **redis-cli** | Not HTTP | n/a | Transparent HTTP proxy **will not decode** redis. REDIRECT 80/443 **won’t see** 6379 | n/a | Protocol fact |
| **agent-browser / Playwright Chromium** | Chromium does **not** use curl-style env as a documented API. Playwright documents a **launch `proxy` option**, not `HTTP_PROXY` inheritance | Chromium `--proxy-server=`; Playwright `proxy`; `--ignore-certificate-errors` (unsafe) | **Yes**, unless product passes proxy into the browser launch | **Chrome Root Store** + OS/enterprise extras / NSS `~/.pki/nssdb` — **not** Debian `update-ca-certificates` alone | [Chrome Root Store FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md); mitmproxy “Chrome on Linux” pointer; Playwright not invoked with proxy in `agent-browser-cli.ts` today |
| **Node `http` tool** | Host Node `fetch` — **outside** the sandbox (map #442). Node honors `NODE_EXTRA_CA_CERTS` for **Node TLS**, not for in-box scanners | n/a | Job A already hooks this path | Node/certifi/OS depending on runtime | `docs/specs/traffic-audit-activity.md`; Node `NODE_EXTRA_CA_CERTS` |

**Read of the table:** env-proxy + CA is sufficient for **curl/wget/Requests-by-default**. It is **not** sufficient for **nmap**, **nuclei-without-`-proxy`**, **ffuf-without-`-x`**, **Playwright Chromium**, or any client that bypasses the proxy. Transparent 80/443 still **misses** nmap SYN, redis, HTTP on odd ports, and HTTP/3-QUIC.

---

## 4. CA install surfaces (Debian-class image + Chrome)

### 4.1 Debian / Kali `update-ca-certificates`

[update-ca-certificates(8)](https://manpages.debian.org/bookworm/ca-certificates/update-ca-certificates.8.en.html):

- Reads `/etc/ca-certificates.conf` + **all `*.crt` under `/usr/local/share/ca-certificates`** (implicitly trusted).
- Rebuilds `/etc/ssl/certs` (hashed symlinks) and **`/etc/ssl/certs/ca-certificates.crt`** (concat bundle).
- Runs `run-parts` on `/etc/ca-certificates/update.d`.

mitmproxy docs point Ubuntu/Debian at this mechanism and give per-invocation examples:

```text
curl --proxy 127.0.0.1:8080 --cacert ~/.mitmproxy/mitmproxy-ca-cert.pem https://example.com/
wget -e https_proxy=127.0.0.1:8080 --ca-certificate ~/.mitmproxy/mitmproxy-ca-cert.pem https://example.com/
```

**Bake vs first-start:** an image `COPY` of a CA + `update-ca-certificates` in the Dockerfile trusts that CA in **every** derived container. Generating CA at **seat first start** and then `update-ca-certificates` inside the running box trusts a **per-seat** (or per-host) CA. Official mitmproxy: CA is **unique per first start** and **must not be shared across devices** if the private key would leak intercept capability.

anything-analyzer (frozen) Debian path: copy to `/usr/local/share/ca-certificates/anything-analyzer.crt` then `update-ca-certificates` (`research/anything-analyzer/src/main/proxy/cert-installer.ts` 157–163). That is a **desktop host** installer, not a Docker image build.

### 4.2 Go tools (nuclei, ffuf, typical httpx)

Go `crypto/x509` on Linux loads, in order, files including **`/etc/ssl/certs/ca-certificates.crt`** (Debian/Ubuntu comment in `root_linux.go` — [go.dev src listing](https://go.dev/src/crypto/x509/root_linux.go) as indexed: first entry `"/etc/ssl/certs/ca-certificates.crt"`). Override env: `SSL_CERT_FILE`, `SSL_CERT_DIR` (OpenSSL-compatible; widely documented around that source file).

**Fact:** `update-ca-certificates` is the **correct** trust injection for in-image Go scanners **if** they use the default `http.Transport` / system pool. It does **not** by itself point those tools at a proxy.

### 4.3 Python Requests / certifi

Requests verifies against **certifi**, “not the OS store”:

- `REQUESTS_CA_BUNDLE` or fallback `CURL_CA_BUNDLE` to a PEM path.
- `verify='/path/to/certfile'` per call.
- `verify=False` disables verification (MITM-blind, not a trust install).

**Fact:** installing the CA only via `update-ca-certificates` can make **curl succeed and Requests fail** on the same box. This is a named honesty item, not a hypothetical.

### 4.4 Chrome / Chromium / Playwright (Linux)

Multiple **primary but non-identical** surfaces:

1. **Chrome Root Store** — Chrome’s own root program, not `/etc/ssl/certs`. FAQ: enterprise policies exist to add private roots; Certificate Manager at `chrome://certificate-manager` (Chrome 134+); [Chrome Root Store FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md).
2. **NSS user DB** — mitmproxy’s “Chrome on Linux” pointer is still `certutil -d sql:$HOME/.pki/nssdb` (classic). `libnss3` **is** in the pen-sandbox image; `libnss3-tools` (`certutil`) is **not** in the Dockerfile package list.
3. **Launch flags** — `--ignore-certificate-errors` disables verification globally (Chromium). Playwright `ignoreHTTPSErrors`. These are **not** CA installs; they hide MITM and real cert errors alike.
4. **`--proxy-server=`** — Chromium explicit proxy; independent of env.

**Unverified in this pass:** whether the exact Playwright Chromium that `agent-browser install` drops on Kali (1) uses Chrome Root Store, (2) reads `~/.pki/nssdb`, (3) reads the OS store via NSS p11-kit. Product Spec cannot honestly say “Debian CA is enough for browser MITM” without a lab check on **that** binary.

**Code fact:** Node4 does not pass Chromium proxy flags today (`runBrowserCommand` execs `agent-browser …` with only `AGENT_BROWSER_SESSION` + HOME env).

### 4.5 Node (host `http` tool, not sandbox)

`NODE_EXTRA_CA_CERTS` is a Node.js documented extra PEM for the **Node** TLS store. It does not install a system CA and does not configure Chromium.

---

## 5. Failure modes a Spec must name honestly

These are **documented or structural**. They are not “we chose poorly.”

### 5.1 Certificate pinning

mitmproxy Certificates: apps using [certificate pinning](https://en.wikipedia.org/wiki/HTTP_Public_Key_Pinning) **will not accept** mitmproxy’s forged leaves without patching the app. Recommended workaround: `ignore_hosts` for those domains (pass-through, **no decrypt**). Mobile-unpinning tools they list (apk-mitm, Frida, …) are **out of scope** for a Linux scanner box.

**Product-honest statement:** MITM coverage is **best-effort decrypt**. Pinned TLS is **opaque** and must not be reported as captured HTTP.

### 5.2 HTTP/2

[mitmproxy Protocols](https://docs.mitmproxy.org/stable/concepts/protocols/): HTTP/2 via hyper-h2; translates to HTTP/1 if upstream is h1. Known limits: **no PRIORITY**; **no push**; **no h2c**. Community reports (e.g. nginx `keepalive_requests` GOAWAY) of proxies mishandling HTTP/2 connection limits — treat as **risk**, not as mitmproxy-guaranteed-broken.

nuclei/ffuf can generate **many concurrent streams**. That is a volume problem (§5.4) as well as HTTP/2.

### 5.3 HTTP/3 / QUIC / UDP

mitmproxy HTTP/3 is documented for **reverse / local / WireGuard**, not as “regular HTTP CONNECT on 8080.” Transparent HOWTO redirects **TCP** 80/443 only. Chrome/nuclei HTTP/3 to UDP/443 **bypasses** TCP REDIRECT and CONNECT.

**Honest:** default MITM observer is **TCP HTTP/1–2**. QUIC is a **named miss** unless a TUN/local-capture path is in scope.

### 5.4 Large concurrency and body budget

- mitmproxy `stream_large_bodies`: bodies over threshold are **streamed and not stored** unless `store_streamed_bodies` (memory). Default product Traffic budget is **64 KiB/side** (`DEFAULT_BODY_BUDGET` in `traffic-collect.ts`; spec allows ≤1 MiB research ceiling).
- nuclei default template runs can emit **thousands** of exchanges per target. Job A hooks never saw them; job D would.
- Map #442 already lists capture-volume control as unspecified.

**Honest:** full nuclei flood through MITM is **not** the same cardinality as curl-hook Traffic. Spec must name sampling / drop / write-method priority / retention — or name unbounded store as a known failure.

### 5.5 Same-netns loops and `--network host`

- Transparent OUTPUT REDIRECT without uid/cgroup exclude **deadlocks** egress (mitmproxy HOWTO).
- Host netns: one listen port; one iptables table; **N sticky seats** are not isolated at L3.
- Docker Desktop host-net ≠ Linux host-net.

### 5.6 Client opt-out of env proxy

Documented bypasses: curl `--noproxy` / empty env; wget `--no-proxy`; Requests `trust_env=False`; sqlmap `--ignore-proxy`; any raw `socket.connect`. An agent in the same box **can** bypass env MITM. Transparent is the mode mitmproxy documents for “applications that bypass the OS HTTP proxy settings.”

### 5.7 mTLS / client certs

mitmproxy Certificates: if the **server** requests a client certificate, the proxy must present one (`client_certs` option). Seat browsers/scanners using mTLS **fail or go opaque** unless that is configured.

### 5.8 Non-HTTP egress

nmap SYN, masscan, redis-cli, raw `nc` — not HTTP exchanges. Traffic spec already: “non-HTTP shell egress stays out.” MITM HTTP proxy does not make them Traffic rows. SNI-only or pcap is a **different** observer.

### 5.9 Sticky stop vs observer process

In-box observer **dies on `docker stop`**. Sidecar needs its own janitor. Official image **regenerates CA** if the cert volume is missing. Spec #426: audit proxy runtime may be ephemeral; operators still need a **stable CA** if browsers already imported it.

### 5.10 Dual-count with job A

Hooks still emit `source=http|browser|shell` for curl/browser. MITM of the same curl would be a **second** row unless deduped. Spec #309 already imagined `source: mitm` as **additive**, not a replacement.

---

## 6. Frozen anything-analyzer patterns (facts about that project)

Not a merge proposal. What that tree **actually does**:

| Piece | Behavior |
|-------|----------|
| `MitmProxyServer` | **Regular HTTP proxy**: `http.createServer` + `connect` handler; HTTPS intercepted by forging leaves from `CaManager`; not transparent iptables | `research/anything-analyzer/src/main/proxy/mitm-proxy-server.ts` 68–115 |
| `CaManager` | Generate/persist RSA 2048 root (“Anything Analyzer CA”), 10y, leaf 825d, LRU 500 host contexts | `ca-manager.ts` |
| `CertInstaller` | **Host OS** trust: Windows `certutil`, macOS `security`, Linux `update-ca-certificates` / `update-ca-trust` / `trust` with **sudo** | `cert-installer.ts` |
| `SystemProxy` | **Host user** proxy: Win HKCU, macOS `networksetup`, Linux **GNOME `gsettings`** — not Docker env, not iptables | `system-proxy.ts` |
| Capture | Same record shape as CDP; `source?: 'cdp' \| 'proxy'`; body cap **1 MiB**; static-extension heuristic | `capture-engine.ts` 19, 39; proxy `MAX_BODY_SIZE = 1 MiB` |
| Config | `enabled`, `port` default **8888**, `caInstalled`, `systemProxy` | `mitm-proxy-config.ts` |

**Facts relative to a Docker seat:** that project assumes a **desktop user session** (gsettings, sudo prompt, OS trust). It does **not** implement sidecar containers, iptables REDIRECT, or `HTTP_PROXY` injection into a Kali box. It **does** demonstrate: regular CONNECT MITM + separate CA manager + **same capture schema** as the non-MITM path (CDP) — analogous to Spec #309 “same `TrafficExchange` + new source.”

---

## 7. Unverified / honest gaps

| Claim | Status |
|-------|--------|
| nuclei honors `HTTP_PROXY` without `-proxy` | **Not in ProjectDiscovery running docs** (only `-p/-proxy`). Do not assert env honor |
| httpx-toolkit / gobuster env vs flags | **Not verified** from manpages this pass |
| Playwright Chromium on this image trusts `update-ca-certificates` | **Not verified**. Chrome Root Store vs NSS vs OS is version-dependent |
| mitmproxy `--mode transparent` on TPROXY vs REDIRECT internals | HOWTO is **REDIRECT**; TPROXY not claimed |
| Lab: nuclei concurrency vs mitmdump on host-net Kali | **Not run**. Cite as risk + mitmproxy stream options only |
| Docker Desktop / WSL2 host-net + iptables OUTPUT | Desktop host-net is **layer 4** and opt-in; local-capture **unsupported** on WSL. Exact REDIRECT behavior **not labbed** |
| sqlmap TLS store (certifi vs system) | sqlmap is Python; **not traced** to certifi vs distro OpenSSL in this pass |

---

## Implications for Spec authors

*Not decisions. Constraints the Spec must not hand-wave.*

1. **`--network host` is already the product default.** Any MITM listen port and any host iptables rule is **host-global** across sticky seats unless the Spec changes network mode or uses marks/ports per seat. Multi-seat isolation (#442 fog) is a **network-mode** question, not a UI filter question.

2. **Env proxy cannot be the sole coverage story** if nuclei/ffuf/nmap/browser are in-scope: those tools’ **primary docs** either require flags, ignore env, or (nmap) cannot proxy TLS/portscan. A Spec that says “set `HTTP_PROXY` on the container” must still name the **miss list** (table §3).

3. **Transparent 80/443 cannot be the sole coverage story** either: odd ports, QUIC, nmap SYN, redis, and same-netns loops. It also still needs CA trust for decrypt.

4. **CA is several stores.** Debian `update-ca-certificates` is necessary for curl/Go; **not sufficient** for Requests (certifi) or Chromium (Root Store / NSS). Spec should list stores, not “install the CA.”

5. **In-box vs sidecar is a lifecycle fact under Spec #426:** `docker stop` kills in-box mitmdump; CA on rootfs survives stop, not rm; official mitmproxy image regenerates CA without a volume. Sidecar on host-net is **not** network-isolated from the seat.

6. **Job D rows vs job A hooks:** same curl can appear twice unless the Spec defines dedup or “MITM is additive for tools job A never saw.”

7. **Volume:** nuclei-scale capture vs 64 KiB bodies vs mitmproxy streaming is an honesty requirement (#442 fog), not a later surprise.

8. **Failure modes to name in product law:** pin → opaque; HTTP/3 miss; env opt-out; proxy down (fail-closed vs degrade — #442 fog); mTLS; non-HTTP.

9. **anything-analyzer** is evidence that **regular CONNECT + CA + shared capture schema** is a complete desktop pattern; it is **not** evidence that gsettings/sudo/OS-proxy maps onto a Kali sticky box.

10. Product Node path remains **Node4 only**. This note does not resurrect Node5 / Soft Graph / Strix.
