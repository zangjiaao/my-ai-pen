import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { JsonTrafficSource } from "./traffic/external-source.js";
import { createTrafficTool } from "./tools/traffic.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

let target = "";
const targetServer = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/account") return send(res, 200, `account:${url.searchParams.get("id") || ""}`);
  if (url.pathname === "/profile") return send(res, 200, `profile:${body}`);
  return send(res, 404, "not found");
});

await listen(targetServer);
target = serverBase(targetServer);

const sourceServer = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/status") return sendJson(res, { ok: true, name: "smoke-source" });
  if (url.pathname === "/traffic") {
    return sendJson(res, {
      requests: [
        {
          id: "req-1",
          method: "GET",
          url: `${target}/account?id=1001`,
          status: 200,
          request_headers: { cookie: "PHPSESSID=abc" },
          response_body: "account:1001",
        },
        {
          id: "req-2",
          method: "POST",
          url: `${target}/profile`,
          status: 200,
          request_headers: { "content-type": "application/x-www-form-urlencoded", cookie: "PHPSESSID=abc" },
          request_body: "name=alice",
          response_body: "profile:name=alice",
        },
        {
          id: "out-of-scope",
          method: "GET",
          url: "http://example.invalid/skip?id=1",
          status: 200,
        },
      ],
    });
  }
  send(res, 404, "not found");
});

await listen(sourceServer);

try {
  const workspaceDir = resolve("tmp", "node2-external-traffic-source-smoke");
  const taskId = `external-traffic-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "external traffic source smoke",
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
    externalTrafficSource: new JsonTrafficSource(serverBase(sourceServer)),
  };
  runtime.plan.start();
  const traffic = createTrafficTool(runtime);

  const status = await execJson(traffic, "source-status", { action: "source_status" });
  if (!status.configured || !status.reachable) throw new Error(`source status failed: ${JSON.stringify(status)}`);

  const synced = await execJson(traffic, "source-sync", { action: "sync", limit: 10 });
  if (synced.synced_count !== 2 || synced.skipped_count !== 1) throw new Error(`unexpected sync result: ${JSON.stringify(synced)}`);

  const candidates = await execJson(traffic, "traffic-candidates", { action: "candidates", limit: 5 });
  if (!Array.isArray(candidates) || candidates.length < 2) throw new Error("expected synced candidates");

  const repeated = await execJson(traffic, "traffic-repeat", { action: "repeat", id: "external_req-1" });
  if (repeated.status !== 200 || !String(repeated.body || "").includes("1001")) throw new Error(`repeat failed: ${JSON.stringify(repeated)}`);

  const mutated = await execJson(traffic, "traffic-mutate", {
    action: "mutate",
    id: "external_req-1",
    param: "id",
    value: "2002",
  });
  if (!String(mutated.body || "").includes("2002")) throw new Error(`mutate failed: ${JSON.stringify(mutated)}`);

  console.log(JSON.stringify({
    ok: true,
    status,
    syncedCount: synced.synced_count,
    skippedCount: synced.skipped_count,
    trafficTotal: runtime.traffic.list({ limit: 50 }).length,
    candidates: candidates.length,
    repeated: repeated.traffic_id,
    mutated: mutated.traffic_id,
    syncEvents: sink.events.filter((event) => event.type === "traffic_synced").length,
  }, null, 2));
} finally {
  await close(sourceServer);
  await close(targetServer);
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function serverBase(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveRead) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
