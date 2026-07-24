# AI 安全运营平台

平台 Web 工作台 + **可绑定的 Node 运行时**（唯一产品路径：**Graph × Pi / `node4/`**）。  
Legacy `node/`、`node2/`、`node3/` 计划删除，禁止扩展。`research/` 与 `benchmarks/` 冻结。

规格入口：

- [`docs/prd.md`](docs/prd.md) — 产品需求  
- [`docs/specs/harness.md`](docs/specs/harness.md) — 运行时契约（Node4 / Graph × Pi）  
- [`AGENTS.md`](AGENTS.md) — Agent 工程规则  
- [`docs/README.md`](docs/README.md) — 文档索引  
- [`docs/project-cleanup-plan.md`](docs/project-cleanup-plan.md) — 清理执行清单  

## 环境准备

```bash
# Python（平台后端）— uv
# Node.js ≥ 22（Node4 + 前端）
```

## 启动

### 1. 基础设施（PostgreSQL + RabbitMQ）

```bash
cd platform
docker compose up -d db rabbitmq
```

可选本地靶场：

```bash
docker compose -f docker-compose.targets.yml up -d   # DVWA :8080, Juice Shop :3000
```

### 2. 平台后端

```bash
cd platform/backend
cp .env.example .env   # 配置数据库与 LLM（平台 Agent）
uv sync
uv run alembic upgrade head
uv run python -m app.db.seed   # 如有 seed：admin@pentest.local / admin123
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. 平台前端

```bash
cd platform/frontend
npm install
npx vite --port 5173
```

打开 `http://localhost:5173` 登录。

### 4. 绑定 Node（`node4`）

在平台 **节点管理** 注册节点并复制 `NODE_TOKEN`。产品唯一 Node 血统为 **node4**（Graph × Pi）。

```bash
cd node4
cp .env.example .env
# NODE_TOKEN=...  PLATFORM_WS_URL=ws://127.0.0.1:8000/ws/node
npm install
npx tsx src/main.ts    # 连接平台
```

Standalone lab（不连平台）：

```bash
cd node4
npx tsx src/standalone.ts \
  --target http://127.0.0.1:8080 \
  --engagement pentest \
  --goal-mode true \
  --output /tmp/node4-run
```

LLM：平台后端 `.env`；Node 侧 `.env`（或 `PI_MODEL_*` / `DEEPSEEK_API_KEY` 等）供执行核。

### 5. 专家角色（可选）

- 对话页选择 **Expert**（pentest / ctf / consult）— 结构化 `engagement`，非 NLP。  
- 节点详情 **专家包** 安装 offers 后，方可派发对应 engagement。  
- 说明：`docs/specs/expert-offers.md`、`docs/specs/ctf-role.md`。

## 技术栈

| 层 | 技术 |
|----|------|
| 平台后端 | FastAPI + PostgreSQL + WebSocket |
| 平台前端 | React + Vite + Tailwind + Zustand + TanStack Query |
| Node | **`node4`**（TS / Graph × Pi）— 部署绑定该血统 |

## 仓库布局（简）

```text
platform/     平台前后端
node4/        产品 Node（WS + standalone）
experts/      专家包目录
docs/         产品主干 + specs/ 运行时契约
benchmarks/   冻结：lab 评估（含历史 Hard-vs-Node5）
research/     冻结：第三方参照
node/ node2/ node3/   legacy，计划删除
```
