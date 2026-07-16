/**
 * Stable platform-connected live DVWA run (full agent + Case DB).
 *
 * Creates a conversation, connects node WS, runs pentest pack against DVWA,
 * dual-writes evidence_created/vuln_found to platform + local capture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import { runNode4Task } from "./runtime/session-runner.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const API = process.env.PLATFORM_API_URL || "http://127.0.0.1:8000";
const target =
  process.env.DVWA_URL?.trim() ||
  process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length) ||
  "http://host.docker.internal:8080";
const ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || "admin@pentest.local";
const ADMIN_PASS = process.env.PLATFORM_ADMIN_PASSWORD || "admin123";

async function api<T>(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const taskId = `n4-dvwa-plat-${stamp}`;
const out = resolve(process.env.NODE4_WORKSPACE || resolve("workspace/dvwa-platform-live"), stamp);
mkdirSync(out, { recursive: true });

// Broader, quality-focused instruction for a stable multi-finding run.
const instruction = `授权安全测试目标（本地靶场，仅本环境）：${target}

应用：DVWA（Damn Vulnerable Web Application）。
默认账号：admin / password。Security Level 设为 Low。

## 本轮目标（信任可复现，简单高效）
1）登录并确认 security=low。
2）覆盖主要模块，优先确认**可证明、可复现**的漏洞：
   - SQL Injection（/vulnerabilities/sqli/）
   - Command Injection（/vulnerabilities/exec/）
   - Reflected XSS（/vulnerabilities/xss_r/）
   - 再有余力：File Inclusion / File Upload / CSRF / Stored XSS 中的可验证项
3）**booking 方式（重要）**：
   - finding(confirm) 时填写 **proof** = 从工具输出中**抄录**的证明片段（SQL 报错、反射脚本、uid= 等）。
   - Case evidence **在 book 时由系统根据 proof 创建**；不要找 evidence_id，也不要传 evidence_ids。
   - poc 写清：怎么复现 + 观测到什么。
   - 一条强 proof 够用；每个模块用该模块自己的证明，不要串模块。
4）结束时至少 **4 个** 不同模块的 confirmed finding；blocked 的在 description 说明原因。

## 约束
- 仅测 ${target}；不要 DoS；不要扫外网。
- 可复现、可信任优先于数量；宁缺毋滥，尽量覆盖 SQLi + Command Injection + XSS。
`;

writeFileSync(resolve(out, "instruction.txt"), instruction, "utf8");

// Preflight
const loginUrl = target.replace(/\/$/, "") + "/login.php";
const pre = await fetch(loginUrl, { signal: AbortSignal.timeout(8000) });
if (!pre.ok && pre.status !== 200) {
  console.error(`[plat-live] DVWA preflight failed ${loginUrl} ${pre.status}`);
  process.exit(1);
}
const apiPre = await fetch(`${API}/docs`, { signal: AbortSignal.timeout(5000) });
if (!apiPre.ok) {
  console.error(`[plat-live] platform not up at ${API}`);
  process.exit(1);
}

const login = await api<{ access_token: string }>("/api/auth/login", {
  method: "POST",
  body: { email: ADMIN_EMAIL, password: ADMIN_PASS },
});
const userToken = login.access_token;
const conv = await api<{ id: string }>("/api/conversations", { method: "POST", token: userToken });
const conversationId = conv.id;
writeFileSync(
  resolve(out, "meta.json"),
  JSON.stringify({ conversationId, taskId, target, stamp, api: API }, null, 2),
);

const config = loadConfig();
if (!config.nodeToken) {
  console.error("[plat-live] NODE_TOKEN missing");
  process.exit(1);
}

const client = new PlatformWSClient(config.platformWsUrl, config.nodeToken);
void client.connect();
await new Promise((r) => setTimeout(r, 1200));

const captured: PlatformMessage[] = [];
const sink: PlatformSink = {
  async send(message: PlatformMessage) {
    const msg = { ...message, conversation_id: conversationId, task_id: taskId };
    captured.push(structuredClone(msg));
    try {
      await client.send(msg);
    } catch (e) {
      console.warn("[plat-live] ws send failed", e);
    }
    if (["task_complete", "task_error", "vuln_found", "evidence_created"].includes(String(msg.type))) {
      if (msg.type === "vuln_found") {
        console.log(`[node4] vuln_found title=${msg.title} eids=${JSON.stringify(msg.evidence_ids)}`);
      } else if (msg.type === "evidence_created") {
        const p = (msg.properties && typeof msg.properties === "object" ? msg.properties : {}) as Record<
          string,
          unknown
        >;
        console.log(
          `[node4] evidence id=${msg.evidence_id} tool=${msg.source_tool} role=${p.role} kind=${p.kind} excerpt=${String(p.excerpt || "").length} path=${p.path_or_url || p.path || p.url || "-"}`,
        );
      } else {
        console.log(`[node4] ${msg.type}`);
      }
    }
  },
};

const task: TaskEnvelope = {
  taskId,
  conversationId,
  instruction,
  target: { type: "url", value: target },
  scope: { allow: [target, "host.docker.internal", "127.0.0.1", "localhost"] },
  engagement: "pentest",
  role: "pentest",
};

config.workspaceDir = out;
console.log(
  `[plat-live] start conv=${conversationId} task=${taskId} target=${target} out=${out} model=${config.modelProvider}/${config.modelId}`,
);

const result = await runNode4Task(config, sink, task);
// let platform flush
await new Promise((r) => setTimeout(r, 2500));

writeFileSync(resolve(out, "platform-messages.json"), JSON.stringify(captured, null, 2));
writeFileSync(
  resolve(out, "run-result.json"),
  JSON.stringify(
    {
      terminalStatus: result.terminalStatus,
      taskDir: result.taskDir,
      conversationId,
      target,
      messageCount: captured.length,
      evidenceCreated: captured.filter((m) => m.type === "evidence_created").length,
      vulnFound: captured.filter((m) => m.type === "vuln_found").length,
    },
    null,
    2,
  ),
);

// Fetch Case evidence/findings from API for durable view
try {
  const evidence = await api<unknown[]>(`/api/evidence?conversation_id=${conversationId}&limit=200`, {
    token: userToken,
  });
  writeFileSync(resolve(out, "case-evidence-api.json"), JSON.stringify(evidence, null, 2));
  const state = await api<Record<string, unknown>>(`/api/conversations/${conversationId}/state`, {
    token: userToken,
  });
  writeFileSync(resolve(out, "case-state-api.json"), JSON.stringify(state, null, 2));
} catch (e) {
  console.warn("[plat-live] API fetch failed", e);
}

writeFileSync(resolve(out, "../LATEST"), out + "\n");
console.log(`[plat-live] terminal=${result.terminalStatus} taskDir=${result.taskDir} messages=${captured.length}`);
client.close();
process.exit(result.terminalStatus === "failed" ? 1 : 0);
