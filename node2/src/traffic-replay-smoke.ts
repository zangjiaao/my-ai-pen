import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createTrafficTool } from "./tools/traffic.js";
import { createVerifierTool } from "./tools/verifier.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/search") return send(res, 200, `search:${url.searchParams.get("q") || ""}`);
  if (url.pathname === "/sqli") return send(res, 200, sqlBody(url.searchParams.get("id") || ""));
  if (url.pathname === "/submit") return send(res, 200, `posted:${body}`);
  return send(res, 404, "not found");
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
const target = `http://127.0.0.1:${address.port}`;

try {
  const workspaceDir = resolve("tmp", "node2-traffic-replay-smoke");
  const taskId = `traffic-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "traffic replay smoke",
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
    trafficProxyUrl: undefined,
  };
  runtime.plan.start();
  const traffic = createTrafficTool(runtime);
  const verifier = createVerifierTool(runtime);

  const added = await execJson(traffic, "traffic-add", {
    action: "add",
    method: "GET",
    url: `${target}/search?q=base`,
    status: 200,
    response_body: "search:base",
    source: "smoke",
  });
  const candidates = await execJson(traffic, "traffic-candidates", { action: "candidates", limit: 5 });
  if (!Array.isArray(candidates) || candidates.length < 1) throw new Error("expected replay candidates");

  const repeated = await execJson(traffic, "traffic-repeat", { action: "repeat", id: added.traffic_id });
  if (repeated.status !== 200 || !repeated.traffic_id) throw new Error("traffic repeat failed");

  const mutated = await execJson(traffic, "traffic-mutate", { action: "mutate", id: added.traffic_id, param: "q", value: "changed" });
  if (!String(mutated.body || "").includes("changed")) throw new Error("traffic mutate failed");

  const verify = await execJson(verifier, "verifier-sqli", {
    vuln_class: "sql-injection",
    url: `${target}/sqli`,
    method: "GET",
    param: "id",
    baseline_payload: "1",
    payload: "1' OR '1'='1",
  });
  if (!verify.confirmed || !Array.isArray(verify.traffic_ids) || verify.traffic_ids.length < 2) {
    throw new Error(`verifier did not persist baseline/attack traffic: ${JSON.stringify(verify)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    trafficTotal: runtime.traffic.list({ limit: 50 }).length,
    candidates: candidates.length,
    repeated: repeated.traffic_id,
    mutated: mutated.traffic_id,
    verifierTrafficIds: verify.traffic_ids,
    events: sink.events.length,
  }, null, 2));
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveRead) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sqlBody(id: string): string {
  if (id.includes("OR")) return "First name: admin\nSurname: admin\nFirst name: user\nSurname: user\nFirst name: gordon\nSurname: brown";
  return "First name: admin\nSurname: admin";
}
