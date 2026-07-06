import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createVerifierTool } from "./tools/verifier.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const uploads = new Map<string, string>();
let csrfName = "initial";

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock server did not bind TCP port");
const target = `http://127.0.0.1:${address.port}`;

try {
  const workspaceDir = resolve("tmp", "node2-verifier-extended-smoke");
  const taskId = `verifier-extended-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "extended verifier smoke",
      target: { type: "url", value: target },
      scope: { allow: [target] },
      snapshot: {},
    },
    workspaceDir,
    platform: sink,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
  };
  runtime.plan.start();
  const verifier = createVerifierTool(runtime);

  const upload = await execJson(verifier, "verify-upload", {
    vuln_class: "file-upload",
    url: "/upload",
    file_field: "uploaded",
    filename: "node2-proof.txt",
    file_content: "NODE2_UPLOAD_PROOF",
  });
  assertConfirmed(upload, "file-upload");
  if (!upload.details?.retrieved_url || upload.requests.length < 2) throw new Error(`upload retrieval proof missing: ${JSON.stringify(upload)}`);

  const csrf = await execJson(verifier, "verify-csrf", {
    vuln_class: "csrf",
    url: "/profile",
    method: "POST",
    check_url: "/profile",
    token_param: "csrf",
    fields: { display_name: "changed-without-token", csrf: "valid-token" },
  });
  assertConfirmed(csrf, "csrf");
  if (!csrf.details?.state_changed || csrf.requests.length < 3) throw new Error(`csrf state proof missing: ${JSON.stringify(csrf)}`);

  const bruteForce = await execJson(verifier, "verify-brute-force", {
    vuln_class: "brute-force",
    url: "/login",
    method: "POST",
    username: "admin",
    password: "password",
    invalid_password: "wrong",
    success_pattern: "Welcome admin",
    failure_pattern: "Invalid login",
  });
  assertConfirmed(bruteForce, "brute-force");

  const jsLogic = await execJson(verifier, "verify-js-logic", {
    vuln_class: "javascript-logic",
    url: "/javascript",
    method: "POST",
    param: "token",
    expected_value: "letmein",
    success_pattern: "accepted",
    failure_pattern: "invalid",
  });
  assertConfirmed(jsLogic, "javascript-logic");

  const traffic = runtime.traffic.list({ limit: 100 });
  const coverage = await runtime.coverage.summary();
  const evidenceEvents = sink.events.filter((event) => event.type === "evidence_created").length;
  if (traffic.length < 9) throw new Error(`expected verifier probes in traffic store: ${traffic.length}`);
  if (evidenceEvents !== 4) throw new Error(`expected four evidence events: ${evidenceEvents}`);
  console.log(JSON.stringify({
    ok: true,
    confirmed: ["file-upload", "csrf", "brute-force", "javascript-logic"],
    trafficCount: traffic.length,
    evidenceEvents,
    coverage,
  }, null, 2));
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function execJson(tool: any, id: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(id, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function assertConfirmed(result: any, label: string): void {
  if (!result.confirmed || !result.evidence_id || !Array.isArray(result.traffic_ids) || result.traffic_ids.length < 2) {
    throw new Error(`${label} was not strongly confirmed: ${JSON.stringify(result)}`);
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/upload") {
    const body = await readBody(req);
    const filename = /filename="([^"]+)"/.exec(body)?.[1] || "upload.txt";
    const content = body.includes("NODE2_UPLOAD_PROOF") ? "NODE2_UPLOAD_PROOF" : "";
    uploads.set(filename, content);
    html(res, `Uploaded <a href="/uploads/${filename}">${filename}</a>`);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
    const filename = decodeURIComponent(url.pathname.split("/").pop() || "");
    text(res, uploads.get(filename) || "missing", uploads.has(filename) ? 200 : 404);
    return;
  }
  if (req.method === "GET" && url.pathname === "/profile") {
    html(res, `<form><input name="display_name" value="${csrfName}"><input name="csrf" value="valid-token"></form>`);
    return;
  }
  if (req.method === "POST" && url.pathname === "/profile") {
    const form = new URLSearchParams(await readBody(req));
    csrfName = form.get("display_name") || csrfName;
    html(res, `Profile updated ${csrfName}`);
    return;
  }
  if (req.method === "POST" && url.pathname === "/login") {
    const form = new URLSearchParams(await readBody(req));
    if (form.get("username") === "admin" && form.get("password") === "password") {
      html(res, "Welcome admin");
    } else {
      html(res, "Invalid login");
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/javascript") {
    html(res, "<script>function token(){ return 'letmein'; }</script>");
    return;
  }
  if (req.method === "POST" && url.pathname === "/javascript") {
    const form = new URLSearchParams(await readBody(req));
    html(res, form.get("token") === "letmein" ? "accepted" : "invalid");
    return;
  }
  text(res, "not found", 404);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveRead) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
  });
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html" });
  res.end(body);
}

function text(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}
