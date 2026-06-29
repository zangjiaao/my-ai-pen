# AI 安全运营平台

## 环境准备

```bash
# 安装 uv (Python 包管理器)
powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"
# 重启终端后生效

# 安装 Node.js (前端)
# https://nodejs.org
```

## 启动

### 1. 基础设施（PostgreSQL + RabbitMQ）

```bash
cd platform
docker compose up -d db rabbitmq
```

### 2. 平台后端

```bash
cd platform/backend
cp .env.example .env
uv sync
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

初始化数据库：
```bash
uv run alembic upgrade head
uv run python -m app.db.seed  # admin@pentest.local / admin123
```

### 3. 平台前端

```bash
cd platform/frontend
npm install
npx vite --port 5173
```

打开 `http://localhost:5173`，用 `admin@pentest.local` / `admin123` 登录。

### 4. 渗透测试 Node

```bash
cd node
cp .env.example .env
# 编辑 .env — 填入 NODE_TOKEN（在平台节点管理页获取）和 LLM_API_KEY
uv sync
uv run python -m pentest_node.main
```

### 5. 测试靶场（可选）

```bash
docker run -d --name dvwa -p 8080:80 vulnerables/web-dvwa
```

## 技术栈

- 后端: FastAPI + PostgreSQL + RabbitMQ
- 前端: React + Vite + Tailwind CSS + Zustand + TanStack Query
- Node: Python + LiteLLM + Docker + Playwright + Textual
- 包管理: uv (Python) / npm (前端)
