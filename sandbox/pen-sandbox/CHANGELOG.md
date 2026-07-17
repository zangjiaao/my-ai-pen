# pen-sandbox changelog

## 0.2.0 — 2026-07-18

- **Unified** pentest expert image: Kali scanners (nuclei, nmap, sqlmap, ffuf, redis-cli, …) + Node/agent-browser.
- Replaces product split of pen-tools vs pen-browser for default Node4 use.
- Build aliases `pen-tools:dev` / `pen-browser:dev` for compatibility.
- **Self-contained Dockerfile** for CI (no private FROM base).
- GitHub Actions → Docker Hub push (`.github/workflows/pen-sandbox.yml`).
