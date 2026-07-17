# First-party L2 tool image for my-ai-pen Node4 (scanners / CLI).
# Not the browser sandbox (strix / Chromium) — see docs/pen-tools-sandbox.md.
#
# Build:  docker build -t pen-tools:dev -f sandbox/pen-tools/Dockerfile sandbox/pen-tools
# Run:    docker run --rm --network host pen-tools:dev nuclei -version

FROM kalilinux/kali-rolling:latest

LABEL org.opencontainers.image.title="my-ai-pen pen-tools" \
      org.opencontainers.image.description="L2 scanner/CLI sandbox for Node4 shell (nuclei, nmap, …)" \
      org.opencontainers.image.source="https://github.com/local/my-ai-pen"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    nmap \
    dnsutils \
    whois \
    whatweb \
    httpx-toolkit \
    gobuster \
    nuclei \
    sqlmap \
    curl \
    wget \
    ffuf \
    git \
    jq \
    redis-tools \
    netcat-openbsd \
    python3 \
    python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Templates as image data layer baseline; ops should still refresh via volume or
# `nuclei -update-templates` on a mounted cache for n-day freshness without rebuild.
RUN nuclei -update-templates || true

WORKDIR /workspace
# Default entrypoint leaves argv free for wrappers: docker run … nuclei -tags minio …
ENTRYPOINT []
CMD ["bash"]
