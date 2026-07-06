FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates docker-cli git && \
    rm -rf /var/lib/apt/lists/* && \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /workspace

COPY research/strix /workspace/research/strix
RUN test -f /workspace/research/strix/README.md && \
    test -f /workspace/research/strix/strix/tools/reporting/tool.py && \
    uv sync --project /workspace/research/strix --no-dev

ENV PATH="/workspace/research/strix/.venv/bin:$PATH"

COPY node3 /workspace/node3

CMD ["python", "/workspace/node3/main.py"]
