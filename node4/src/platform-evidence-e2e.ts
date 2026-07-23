/**
 * Platform-connected evidence E2E (Case DB):
 * 1) Login + create conversation
 * 2) Node WS connect (NODE_TOKEN)
 * 3) Real tools against DVWA → evidence_created / vuln_found
 * 4) Read /api/evidence + case_context-style scoring
 *
 * Requires platform backend on :8000 and DVWA reachable.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlatformWSClient } from "./platform/ws-client.js";
import { EvidenceStore } from "./stores/evidence.js";
import { GoalStore } from "./stores/goal.js";
import { TodoStore } from "./stores/todo.js";
import { createFindingTool } from "./tools/finding.js";
import { createWriteTool } from "./tools/fs-tools.js";
import { createHttpTool } from "./tools/http.js";
import { createShellTool } from "./tools/shell.js";
import type { PlatformMessage, ToolRuntime } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const API = process.env.PLATFORM_API_URL || "http://127.0.0.1:8000";
const DVWA = process.env.DVWA_URL || "http://host.docker.internal:8080";
const ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || "admin@pentest.local";
const ADMIN_PASS = process.env.PLATFORM_ADMIN_PASSWORD || "admin123";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content || [])
    .filter((c) => c && (c.type === "text" || c.text != null))
    .map((c) => c.text || "")
    .join("\n");
}

function hollow(props: Record<string, unknown> | undefined): boolean {
  if (!props || typeof props !== "object") return true;
  for (const key of [
    "stdout",
    "excerpt",
    "body_preview",
    "response_body",
    "preview",
    "path",
    "path_or_url",
    "url",
    "command",
  ]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return false;
  }
  return true;
}

async function api<T = unknown>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function main(): Promise<void> {
  // Preflight
  const health = await fetch(`${API}/docs`).catch(() => null);
  assert(health && health.ok, `platform not up at ${API}`);
  const dvwa = await fetch(`${DVWA}/login.php`, { signal: AbortSignal.timeout(8000) });
  assert(dvwa.ok || dvwa.status === 200, `DVWA not reachable: ${DVWA}`);

  const login = await api<{ access_token: string }>("/api/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASS },
  });
  const token = login.access_token;
  assert(token, "login token");

  const conv = await api<{ id: string }>("/api/conversations", { method: "POST", token });
  const conversationId = conv.id;
  assert(conversationId, "conversation id");
  console.log(`[e2e] conversation=${conversationId}`);

  const config = loadConfig();
  assert(config.nodeToken, "NODE_TOKEN required");
  const client = new PlatformWSClient(config.platformWsUrl, config.nodeToken);

  // Connect node WS in background
  const connectP = client.connect();
  await new Promise((r) => setTimeout(r, 1500)); // allow handshake

  const taskId = `plat-ev-${Date.now()}`;
  const taskDir = join(tmpdir(), taskId);
  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "notes/source_dump"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });

  const sent: PlatformMessage[] = [];
  const platform = {
    async send(message: PlatformMessage) {
      const msg = {
        ...message,
        conversation_id: conversationId,
        task_id: taskId,
      };
      sent.push(msg);
      await client.send(msg);
    },
  };

  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId,
      instruction: "platform evidence e2e",
      target: { type: "url", value: DVWA },
      scope: { allow: [DVWA, "host.docker.internal", "127.0.0.1", "localhost"] },
      engagement: "pentest",
    },
    workspaceDir: taskDir,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: {},
  };

  const http = createHttpTool(runtime);
  const shell = createShellTool(runtime);
  const write = createWriteTool(runtime);
  const finding = createFindingTool(runtime);

  // --- Act tools against real DVWA ---
  const loginHttp = JSON.parse(
    textOf(await http.execute("h1", { method: "GET", url: `${DVWA}/login.php` })),
  );
  assert(loginHttp.evidence_id, "http evidence");
  console.log(`[e2e] http login body_len=${String(loginHttp.body || "").length} eid=${loginHttp.evidence_id}`);

  // Empty-ish root (may redirect) — should still persist with role
  const rootHttp = JSON.parse(
    textOf(await http.execute("h0", { method: "GET", url: `${DVWA}/` })),
  );
  console.log(`[e2e] http root status=${rootHttp.status} eid=${rootHttp.evidence_id}`);

  const shellRes = JSON.parse(
    textOf(
      await shell.execute("s1", {
        command: [
          `BASE='${DVWA}'`,
          "CK=$(mktemp)",
          "HTML=$(curl -sS -c \"$CK\" -b \"$CK\" \"$BASE/login.php\")",
          "TOKEN=$(printf '%s' \"$HTML\" | sed -n \"s/.*name='user_token' value='\\([^']*\\)'.*/\\1/p\" | head -1)",
          "curl -sS -c \"$CK\" -b \"$CK\" -X POST \"$BASE/login.php\" -d \"username=admin&password=password&Login=Login&user_token=$TOKEN\" -o /dev/null",
          "echo SQLI_PROBE:",
          "curl -sS -b \"$CK\" -b \"security=low\" \"$BASE/vulnerabilities/sqli/?id=1'+OR+'1'='1&Submit=Submit\" | head -c 2000",
          "echo",
          "mkdir -p notes/source_dump",
          "echo '<?php // leaked sample' > notes/source_dump/sqli_hint.php",
          "cat notes/source_dump/sqli_hint.php",
          "rm -f \"$CK\"",
        ].join(" && "),
        timeout_seconds: 60,
      }),
    ),
  );
  assert(shellRes.evidence_id, "shell evidence");
  console.log(`[e2e] shell stdout_len=${String(shellRes.stdout || "").length} eid=${shellRes.evidence_id}`);

  const writeRes = JSON.parse(
    textOf(
      await write.execute("w1", {
        path: "notes/source_dump/sqli/index.php",
        content:
          "<?php\n$id = $_GET['id'];\n$query = \"SELECT first_name FROM users WHERE user_id = '$id'\";\n?>\n",
      }),
    ),
  );
  assert(writeRes.evidence_id, "write evidence");

  // Book two findings with dedicated evidence — third reuse of same eid should fail if over cap
  const book1 = textOf(
    await finding.execute("f1", {
      action: "confirm",
      title: "SQL Injection on DVWA sqli module",
      severity: "high",
      location: `${DVWA}/vulnerabilities/sqli/`,
      description: "User id parameter reaches SQL without parameterization; multi-row data returned.",
      poc: "Login admin/password; GET /vulnerabilities/sqli/?id=1' OR '1'='1 → First name rows in body",
      evidence_ids: [shellRes.evidence_id, writeRes.evidence_id],
    }),
  );
  assert(book1.includes('"ok": true') || book1.includes('"ok":true'), `book1 fail: ${book1.slice(0, 300)}`);

  // Second finding reusing shell — must mention location in excerpt (sqli path likely present)
  const book2 = textOf(
    await finding.execute("f2", {
      action: "confirm",
      title: "Source material available for audit (sqli source dump)",
      severity: "medium",
      location: `${DVWA}/vulnerabilities/sqli/`,
      description: "Source dump recorded for code-audit follow-up on the same endpoint family.",
      poc:
        "write notes/source_dump/sqli/index.php containing SELECT user_id query → observed file preview includes the SQL string",
      evidence_ids: [writeRes.evidence_id, loginHttp.evidence_id],
    }),
  );
  assert(book2.includes('"ok": true') || book2.includes('"ok":true'), `book2 fail: ${book2.slice(0, 300)}`);

  // Third booking of same write after 2 uses — should fail mass-reuse / location mismatch
  const book3 = textOf(
    await finding.execute("f3", {
      action: "confirm",
      title: "Unrelated claim should not mass-reuse write evidence",
      severity: "low",
      location: `${DVWA}/vulnerabilities/upload/`,
      description: "This claim is about upload and must not blindly reuse sqli dump evidence.",
      poc: "POST /vulnerabilities/upload/ with shell.php → observed response status and body confirm write",
      evidence_ids: [writeRes.evidence_id],
    }),
  );
  const reuseBlocked =
    book3.includes("already linked") ||
    book3.includes("does not mention") ||
    book3.includes("dedicated probe") ||
    book3.includes("cannot prove");
  console.log(`[e2e] mass-reuse blocked=${reuseBlocked} book3=${book3.slice(0, 160)}`);

  // Allow platform to persist
  await new Promise((r) => setTimeout(r, 2000));

  // --- Read Case evidence from platform API ---
  const rows = await api<
    Array<{
      evidence_id: string;
      source_tool: string | null;
      type: string;
      summary: string | null;
      properties: Record<string, unknown>;
    }>
  >(`/api/evidence?conversation_id=${conversationId}&limit=100`, { token });

  console.log(`[e2e] Case DB evidence rows=${rows.length}`);
  assert(rows.length >= 3, `expected Case evidence rows, got ${rows.length}`);

  const byId = new Map(rows.map((r) => [r.evidence_id, r]));
  for (const eid of [loginHttp.evidence_id, shellRes.evidence_id, writeRes.evidence_id] as string[]) {
    const row = byId.get(eid);
    assert(row, `missing Case row ${eid}`);
    const props = row!.properties || {};
    assert(!hollow(props), `hollow Case properties for ${eid}: ${JSON.stringify(props).slice(0, 200)}`);
    assert(props.role, `${eid} missing role`);
    console.log(
      `  ${eid} tool=${row!.source_tool} role=${props.role} kind=${props.kind} excerpt_len=${String(props.excerpt || "").length} path=${props.path_or_url || props.path || props.url || "-"}`,
    );
  }

  // write material
  const writeRow = byId.get(writeRes.evidence_id as string)!;
  assert(
    writeRow.properties.kind === "source_excerpt" || writeRow.properties.kind === "file",
    `write kind=${writeRow.properties.kind}`,
  );
  assert(String(writeRow.properties.path_or_url || writeRow.properties.path || "").includes("source_dump"));

  // shell should have stdout excerpt
  const shellRow = byId.get(shellRes.evidence_id as string)!;
  assert(String(shellRow.properties.excerpt || shellRow.properties.stdout || "").length > 20, "shell Case excerpt");

  // proof-role hollow rate among rows with role=proof
  const proofRows = rows.filter((r) => (r.properties || {}).role === "proof");
  const proofHollow = proofRows.filter((r) => hollow(r.properties));
  console.log(`[e2e] proof_rows=${proofRows.length} proof_hollow=${proofHollow.length}`);
  assert(proofHollow.length === 0, `proof hollow in Case: ${proofHollow.map((r) => r.evidence_id)}`);

  // case_context builder via python path - optional import through HTTP state
  const state = await api<{ evidence?: unknown[]; findings?: unknown[] }>(
    `/api/conversations/${conversationId}/state`,
    { token },
  );
  console.log(
    `[e2e] snapshot findings=${Array.isArray(state.findings) ? state.findings.length : "?"} evidence_field=${Array.isArray(state.evidence) ? state.evidence.length : "?"}`,
  );

  // DB direct score via API list is enough for Case hollow metric
  const report = {
    conversation_id: conversationId,
    target: DVWA,
    case_evidence_count: rows.length,
    proof_rows: proofRows.length,
    proof_hollow: proofHollow.length,
    mass_reuse_blocked: reuseBlocked,
    samples: rows.slice(0, 12).map((r) => ({
      id: r.evidence_id,
      tool: r.source_tool,
      role: r.properties?.role,
      kind: r.properties?.kind,
      excerpt_len: String(r.properties?.excerpt || "").length,
      hollow: hollow(r.properties),
      path: r.properties?.path_or_url || r.properties?.path || r.properties?.url,
    })),
    pass:
      rows.length >= 3 &&
      proofHollow.length === 0 &&
      byId.has(writeRes.evidence_id as string) &&
      byId.has(shellRes.evidence_id as string),
  };

  const outDir = join(process.cwd(), "workspace", "platform-evidence-e2e");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "case-evidence.json"), JSON.stringify(rows, null, 2));
  await writeFile(join(outDir, "sent-messages.json"), JSON.stringify(sent, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`[e2e] wrote ${outDir}`);

  client.close();
  // don't await connect forever
  void connectP.catch(() => undefined);

  if (!report.pass) process.exit(1);
  // force exit — WS reconnect loop otherwise keeps process alive
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
