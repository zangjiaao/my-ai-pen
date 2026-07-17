# Unified pentest expert sandbox: scanners + agent-browser.
# Prefer building FROM a known-good scanner base (local pen-tools / pentest-sandbox).
#
# Build:  bash sandbox/pen-sandbox/scripts/build.sh
# Requires one of: pen-tools:dev | pentest-sandbox:latest (or set PEN_SANDBOX_BASE)

ARG PEN_SANDBOX_BASE=pen-tools:dev
FROM ${PEN_SANDBOX_BASE}

LABEL org.opencontainers.image.title="my-ai-pen pen-sandbox" \
      org.opencontainers.image.description="Pentest expert sandbox: nuclei/nmap/… + agent-browser"

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root

# Browser runtime libs (best-effort; base image may already include many)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      gnupg \
      fonts-liberation \
      fonts-noto-color-emoji \
      libnss3 \
      libnspr4 \
      libatk-bridge2.0-0 \
      libdrm2 \
      libgbm1 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libasound2t64 \
      libgtk-3-0 \
    || apt-get install -y --no-install-recommends \
      curl ca-certificates fonts-liberation libnss3 libgbm1 libgtk-3-0 \
    || true \
    && apt-get clean && rm -rf /var/lib/apt/lists/* || true

# Node 22 + agent-browser (if node missing on base)
RUN if ! command -v node >/dev/null 2>&1; then \
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
      && apt-get install -y --no-install-recommends nodejs \
      && apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi \
    && npm install -g agent-browser@0.11.0 \
    && agent-browser install || true

WORKDIR /workspace
ENTRYPOINT []
CMD ["bash", "-lc", "sleep infinity"]
