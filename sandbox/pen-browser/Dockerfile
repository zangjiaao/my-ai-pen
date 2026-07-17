# First-party browser sandbox for Node4 (S5) — not Strix.
# Chromium/Chrome + agent-browser only. Scanners stay in pen-tools.
#
# Build: bash sandbox/pen-browser/scripts/build.sh

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="my-ai-pen pen-browser" \
      org.opencontainers.image.description="L2 browser sandbox: Chrome + agent-browser for Node4"

ENV DEBIAN_FRONTEND=noninteractive \
    # agent-browser stores Chrome under this user's home when installed as root
    HOME=/root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    bash \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Global CLI + download Chrome for Testing into /root/.agent-browser
RUN npm install -g agent-browser@0.11.0 \
    && agent-browser install || true

WORKDIR /workspace
# Keep alive for docker exec sessions (Node4 browser pattern)
ENTRYPOINT []
CMD ["bash", "-lc", "sleep infinity"]
