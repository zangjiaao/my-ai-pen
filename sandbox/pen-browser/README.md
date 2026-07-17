# pen-browser (first-party browser sandbox)

**S5:** Node4 browser tool default image, owned by my-ai-pen — **not** Strix.

| Image | Role |
|-------|------|
| **pen-browser** | Chromium + `agent-browser` only |
| **pen-tools** | nuclei/nmap/sqlmap shell scanners |
| **strix-sandbox** | Legacy third-party (browser + full Kali tools); fallback only |

Strix **does** include bash and even nuclei, but Node4 historically only `docker exec`’d `agent-browser` into it. Product direction: **browser image ≠ scanner image**.

## Build

```bash
bash sandbox/pen-browser/scripts/build.sh
```

## Node4

Default resolution (see `browser-sandbox.ts`):

1. `NODE4_BROWSER_SANDBOX_IMAGE` if set  
2. `pen-browser:dev` if local image exists  
3. `ghcr.io/usestrix/strix-sandbox:1.0.0` fallback  

Disable sandbox: `NODE4_BROWSER_SANDBOX=0` (host agent-browser).
