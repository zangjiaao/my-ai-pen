# pen-tools (L2 scanner sandbox)

**Owned by my-ai-pen** — not Strix.

| Image role | Default today | This tree |
|------------|---------------|-----------|
| **Browser sandbox** | `ghcr.io/usestrix/strix-sandbox` (Chromium + `agent-browser`) | Unchanged; see `node4` browser tool |
| **Tool / scanner sandbox** | Host PATH (or ad-hoc `pentest-sandbox:latest`) | **`pen-tools`** — nuclei, nmap, sqlmap, ffuf, redis-cli, … |

Node4 `shell` still runs on the **host** unless you put wrappers on `PATH` or later wire shell→docker.  
Expert packs assume scanners may live in L2; they do not vendor binaries.

## Build

```bash
# from repo root
docker build -t pen-tools:dev -f sandbox/pen-tools/Dockerfile sandbox/pen-tools
```

Optional: retag local legacy image while iterating:

```bash
docker tag pentest-sandbox:latest pen-tools:dev   # if already built from node/Dockerfile.sandbox
```

## Templates (data layer)

Prefer **not** rebuilding the image for every template update:

```bash
# host cache
mkdir -p "$HOME/.cache/pen-tools/nuclei-templates"
docker run --rm -v "$HOME/.cache/pen-tools/nuclei-templates:/root/nuclei-templates" \
  pen-tools:dev nuclei -update-templates
```

Wrappers below mount that cache when present.

## Host wrappers (lab / bridge)

```bash
export PATH="/path/to/repo/sandbox/pen-tools/bin:$PATH"
nuclei -version    # docker run pen-tools
```

Env:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PEN_TOOLS_IMAGE` | `pen-tools:dev` | Image tag |
| `PEN_TOOLS_NETWORK` | `host` | Docker network mode |
| `PEN_TOOLS_NUCLEI_TEMPLATES` | `~/.cache/pen-tools/nuclei-templates` if dir exists | Mount over container templates |

## Node4 integration (roadmap)

1. **Now:** wrappers + docs; lab re-runs with `PATH=…/sandbox/pen-tools/bin:$PATH`.  
2. **Next:** pin `PEN_TOOLS_IMAGE` in node env / compose; CI build `pen-tools`.  
3. **Later (optional):** shell tool executes inside pen-tools container (taskDir mount) so host need not install scanners.  
4. **Browser** stays separate image (strix fork or first-party browser image when we leave Strix).

See [`docs/pen-tools-sandbox.md`](../../docs/pen-tools-sandbox.md).
