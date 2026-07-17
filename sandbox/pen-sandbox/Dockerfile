# Unified pentest expert sandbox for Node4 (shell scanners + browser).
# Self-contained for CI / Docker Hub — no private base image required.
#
# Local:  bash sandbox/pen-sandbox/scripts/build.sh
# CI:     docker/build-push-action with this file

FROM kalilinux/kali-rolling:latest

LABEL org.opencontainers.image.title="my-ai-pen pen-sandbox" \
      org.opencontainers.image.description="Pentest expert sandbox: nuclei/nmap/sqlmap/ffuf + agent-browser" \
      org.opencontainers.image.source="https://github.com/local/my-ai-pen"

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root

# --- Scanners / recon (keep package list lean; avoid flaky optional browser packages) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    gnupg \
    nmap \
    dnsutils \
    whois \
    whatweb \
    httpx-toolkit \
    gobuster \
    nuclei \
    sqlmap \
    ffuf \
    git \
    jq \
    redis-tools \
    netcat-openbsd \
    python3 \
    python3-pip \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libasound2 \
    xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN nuclei -update-templates || true

# --- Node.js 22 + agent-browser ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && npm install -g agent-browser@0.11.0 \
    && agent-browser install || true

WORKDIR /workspace
ENTRYPOINT []
CMD ["bash", "-lc", "sleep infinity"]
