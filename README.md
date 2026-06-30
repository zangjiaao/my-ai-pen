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
# 编辑 .env - 填入 LLM_API_KEY，用于任务完成后的平台 Agent 对话
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
# 编辑 .env - 填入 NODE_TOKEN（在平台节点管理页获取）和 LLM_API_KEY
uv sync
uv run python -m pentest_node.main
```


LLM 配置分两处：
- `platform/backend/.env`：平台 Agent 使用，负责任务完成后的会话追问、结果解释和已保存上下文问答。
- `node/.env`：渗透测试 Agent 使用，负责执行任务、调用工具和推进测试流程。

MVP 阶段两处可以使用同一个 OpenAI 兼容服务和同一把 key，但需要分别配置。

### 5. 测试靶场（可选）

```bash
docker run -d --name dvwa -p 8080:80 vulnerables/web-dvwa
```

## 技术栈

- 后端: FastAPI + PostgreSQL + RabbitMQ
- 前端: React + Vite + Tailwind CSS + Zustand + TanStack Query
- Node: Python + OpenAI SDK + Docker + Playwright + Textual
- 包管理: uv (Python) / npm (前端)
