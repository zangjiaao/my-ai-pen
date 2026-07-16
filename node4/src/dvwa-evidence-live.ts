/**
 * Live Node4 + pentest pack against real DVWA.
 * Captures all platform messages (including evidence_created) for plan acceptance.
 *
 * Usage (from node4/):
 *   DVWA_URL=http://host.docker.internal:8080 npx tsx src/dvwa-evidence-live.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { runNode4Task } from "./runtime/session-runner.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const target =
  process.env.DVWA_URL?.trim() ||
  process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length) ||
  "http://host.docker.internal:8080";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const taskId = `n4-dvwa-ev-${stamp}`;
const out = resolve(process.env.NODE4_WORKSPACE || resolve("workspace/dvwa-evidence-live"), stamp);
mkdirSync(out, { recursive: true });

const instruction = `授权安全测试目标（本地靶场，仅本环境）：${target}

应用：DVWA（Damn Vulnerable Web Application）。
默认账号：admin / password。Security Level 尽量设为 Low。

本轮目标（聚焦、可验证）：
1）登录 DVWA。
2）至少确认 1–2 个可复现漏洞（优先 SQL Injection 和/或 Command Injection 或 XSS reflected），必须有响应体/stdout 证据。
3）若拿到源码/脚本，用 write 落到 notes/source_dump/ 下，以便后续 code-audit 接力。
4）每个确认漏洞：finding(action=confirm) + evidence_ids（含 demonstrable output）。

约束：仅测 ${target}；不要 DoS；不要扫外网。`;

writeFileSync(resolve(out, "instruction.txt"), instruction, "utf8");

// Preflight
const loginUrl = target.replace(/\/$/, "") + "/login.php";
try {
  const res = await fetch(loginUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok && res.status !== 200) {
    console.error(`[live] DVWA preflight failed: ${loginUrl} status=${res.status}`);
    process.exit(1);
  }
  console.log(`[live] DVWA preflight OK ${loginUrl} status=${res.status}`);
} catch (e) {
  console.error(`[live] DVWA unreachable: ${loginUrl}`, e);
  process.exit(1);
}

const captured: PlatformMessage[] = [];
class CaptureSink implements PlatformSink {
  async send(message: PlatformMessage): Promise<void> {
    captured.push(structuredClone(message));
    if (["task_complete", "task_error", "vuln_found", "evidence_created", "todo_updated"].includes(message.type)) {
      const props =
        message.properties && typeof message.properties === "object"
          ? (message.properties as Record<string, unknown>)
          : {};
      if (message.type === "evidence_created") {
        console.log(
          `[node4] evidence_created id=${message.evidence_id} tool=${message.source_tool} role=${props.role} kind=${props.kind} excerpt_len=${String(props.excerpt || "").length} path=${props.path_or_url || props.path || props.url || "-"}`,
        );
      } else if (message.type === "vuln_found") {
        console.log(`[node4] vuln_found title=${message.title} eids=${JSON.stringify(message.evidence_ids)}`);
      } else {
        console.log(`[node4] ${message.type}`);
      }
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
  scope: {
    allow: [target, "host.docker.internal", "127.0.0.1", "localhost"],
  },
  engagement: "pentest",
  role: "pentest",
};

console.log(
  `[live] start task=${taskId} target=${target} out=${out} model=${config.modelProvider}/${config.modelId}`,
);

const result = await runNode4Task(config, new CaptureSink(), task);
writeFileSync(resolve(out, "platform-messages.json"), JSON.stringify(captured, null, 2));
writeFileSync(
  resolve(out, "run-result.json"),
  JSON.stringify(
    {
      terminalStatus: result.terminalStatus,
      taskDir: result.taskDir,
      target,
      messageCount: captured.length,
      evidenceCreated: captured.filter((m) => m.type === "evidence_created").length,
      vulnFound: captured.filter((m) => m.type === "vuln_found").length,
    },
    null,
    2,
  ),
);
console.log(`[live] terminal=${result.terminalStatus} taskDir=${result.taskDir} messages=${captured.length}`);
writeFileSync(resolve(out, "../LATEST"), out + "\n", "utf8");
if (result.terminalStatus === "failed") process.exit(1);
