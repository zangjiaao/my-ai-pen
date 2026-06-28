# AI 安全运营平台

## 启动

### 1. 基础设施（PostgreSQL + RabbitMQ + 平台后端）

```bash
cd platform
docker compose up -d
```

启动后：
- 平台后端: `http://localhost:8000`
- PostgreSQL: `localhost:5432` (postgres/postgres)
- RabbitMQ 管理界面: `http://localhost:15672` (guest/guest)

### 2. 初始化数据库

```bash
cd platform/backend
pip install -r requirements.txt
alembic upgrade head
python -m app.db.seed  # 创建 admin@pentest.local / admin123
```

### 3. 平台前端

```bash
cd platform/frontend
npm install
npm run dev
```

打开 `http://localhost:5173`，用 `admin@pentest.local` / `admin123` 登录。

### 4. 渗透测试 Node

```bash
cd node
pip install -r requirements.txt

# 平台模式（在线）
python -m pentest_node.main

# 独立模式（离线）
python -m pentest_node.main --standalone --config engagement.yaml
```

需要先在平台上注册 Node 获取 Token：
1. 浏览器登录 → 节点管理 → 注册节点
2. 复制生成的 Token
3. 设置环境变量 `NODE_TOKEN=<token>` 后启动 Node

Node 启动后 WebSocket 自动连接平台，即可在平台上创建会话。

### 5. 构建沙箱镜像（Node 依赖）

```bash
cd node
docker build -f Dockerfile.sandbox -t pentest-sandbox:latest .
```

### 6. 测试靶场（可选）

```bash
docker compose -f platform/docker-compose.targets.yml up -d
# DVWA: http://localhost:8080
# Juice Shop: http://localhost:3000
```

## 技术栈

- 后端: FastAPI + PostgreSQL + RabbitMQ
- 前端: React + shadcn/ui + Zustand + TanStack Query
- Node: Python + PydanticAI/LiteLLM + Docker + Playwright + Textual
