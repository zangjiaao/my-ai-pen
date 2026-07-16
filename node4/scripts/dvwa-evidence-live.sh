#!/usr/bin/env bash
# Live Node4 pentest against DVWA — capture evidence_created for plan acceptance.
set -euo pipefail
export PATH="${HOME}/.local/node/bin:/usr/bin:${PATH}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
# shellcheck disable=SC1091
[ -f .env ] && . .env
[ -f ../node2/.env ] && . ../node2/.env
set +a

# Prefer user/docker-style host; fall back to loopback.
TARGET="${DVWA_URL:-http://host.docker.internal:8080}"
if ! curl -sS -o /dev/null -w '' --connect-timeout 3 "$TARGET/login.php" 2>/dev/null; then
  TARGET="http://127.0.0.1:8080"
fi
if ! curl -sS -o /dev/null --connect-timeout 3 "$TARGET/login.php" 2>/dev/null; then
  echo "DVWA not reachable at host.docker.internal:8080 or 127.0.0.1:8080" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${NODE4_WORKSPACE:-$ROOT/workspace}/dvwa-evidence-live/$STAMP"
mkdir -p "$OUT"
TASK_ID="n4-dvwa-ev-${STAMP}"
INSTR="$OUT/instruction.txt"

export PI_MODEL_PROVIDER="${PI_MODEL_PROVIDER:-deepseek}"
export PI_MODEL="${PI_MODEL:-deepseek-v4-flash}"
export NODE4_MAX_CONTINUES="${NODE4_MAX_CONTINUES:-6}"
export NODE4_MAX_EMPTY_STOPS="${NODE4_MAX_EMPTY_STOPS:-1}"
export NODE4_MAX_PREMATURE_STOPS="${NODE4_MAX_PREMATURE_STOPS:-2}"
export NODE4_WORKSPACE="$OUT"
export PI_AGENT_DIR="${PI_AGENT_DIR:-$ROOT/.pi-agent}"

cat >"$INSTR" <<EOF
授权安全测试目标（本地靶场，仅本环境）：${TARGET}

应用：DVWA（Damn Vulnerable Web Application）。
默认账号：admin / password。Security Level 尽量设为 Low。

本轮目标（聚焦、可验证）：
1）登录 DVWA。
2）至少确认 1–2 个可复现漏洞（优先 SQL Injection 和/或 Command Injection 或 XSS reflected），必须有响应体/stdout 证据。
3）若拿到源码/脚本，用 write 落到 notes/source_dump/ 下，以便后续 code-audit 接力。
4）每个确认漏洞：finding(action=confirm) + evidence_ids（含 demonstrable output）。

约束：仅测 ${TARGET}；不要 DoS；不要扫外网。
EOF

echo "[live] target=$TARGET task=$TASK_ID out=$OUT model=$PI_MODEL_PROVIDER/$PI_MODEL continues=$NODE4_MAX_CONTINUES"

# Capture sink via node runner (standalone drops evidence_created logs)
node --import tsx/esm - <<'NODE' "$OUT" "$TASK_ID" "$TARGET" "$INSTR"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { runNode4Task } from "../src/runtime/session-runner.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../src/types.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const out = resolve(process.argv[2]!);
const taskId = process.argv[3]!;
const target = process.argv[4]!;
const instrPath = process.argv[5]!;
const instruction = readFileSync(instrPath, "utf8");

const captured: PlatformMessage[] = [];
class CaptureSink implements PlatformSink {
  async send(message: PlatformMessage): Promise<void> {
    captured.push(message);
    if (["task_complete", "task_error", "vuln_found", "evidence_created", "todo_updated"].includes(message.type)) {
      const props = message.properties && typeof message.properties === "object" ? message.properties : {};
      const brief =
        message.type === "evidence_created"
          ? ` id=${message.evidence_id} tool=${message.source_tool} role=${(props as any).role} kind=${(props as any).kind} excerpt_len=${String((props as any).excerpt || "").length}`
          : message.type === "vuln_found"
            ? ` title=${message.title} eids=${JSON.stringify(message.evidence_ids)}`
            : "";
      console.log(`[node4] ${message.type}${brief}`);
    }
  }
}

const config = loadConfig();
config.workspaceDir = out;

const task: TaskEnvelope = {
  taskId,
  conversationId: `conv-${taskId}`,
  instruction,
  target: { type: "url", value: target },
  scope: { allow: [target, "host.docker.internal", "127.0.0.1", "localhost"] },
  engagement: "pentest",
  role: "pentest",
};

const result = await runNode4Task(config, new CaptureSink(), task);
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "platform-messages.json"), JSON.stringify(captured, null, 2));
writeFileSync(
  resolve(out, "run-result.json"),
  JSON.stringify({ terminalStatus: result.terminalStatus, taskDir: result.taskDir, target }, null, 2),
);
console.log(`[live] terminal=${result.terminalStatus} taskDir=${result.taskDir} messages=${captured.length}`);
if (result.terminalStatus === "failed") process.exit(1);
NODE

echo "[live] done OUT=$OUT"
echo "$OUT" >"$ROOT/workspace/dvwa-evidence-live/LATEST"
