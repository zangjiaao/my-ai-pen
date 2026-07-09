/**
 * P2 traffic pipeline: add → candidates/analyze → repeat baseline → mutate → coverage/evidence links.
 * In-process only (no external Caido required).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createTrafficTool } from "./tools/traffic.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/search") {
    return send(res, 200, `search:${url.searchParams.get("q") || ""}`, {
      "set-cookie": "SID=from-search; Path=/",
    });
  }
  if (url.pathname === "/echo" && req.method === "POST") {
    return send(res, 200, `posted:${body}`);
  }
  return send(res, 404, "not found");
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server bind failed");
const target = `http://127.0.0.1:${address.port}`;

async function execJson(tool: any, id: string, params: any): Promise<any> {
  const result = await tool.execute(id, params);
  const text = (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join("\n");
  return JSON.parse(text);
}

try {
  const workspaceDir = resolve("tmp", "node2-p2-traffic-smoke");
  const taskId = `p2-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "p2 traffic pipeline",
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
  const traffic = createTrafficTool(runtime);

  const added = await execJson(traffic, "add", {
    action: "add",
    method: "GET",
    url: `${target}/search?q=base`,
    status: 200,
    response_body: "search:base form name=\"id\" action=\"/sqli\"",
    source: "browser",
  });
  assert(added.traffic_id, "add missing traffic_id");

  // Explicit parameterized high-value surface should seed coverage candidates.
  const sqliSurface = await execJson(traffic, "add-sqli", {
    action: "add",
    method: "GET",
    url: `${target}/search?id=1`,
    status: 200,
    response_body: "User ID exists",
    source: "browser",
  });
  assert(sqliSurface.traffic_id, "sqli surface add missing traffic_id");

  const candidates = await execJson(traffic, "candidates", { action: "candidates", limit: 10 });
  assert(Array.isArray(candidates) && candidates.length >= 1, "candidates empty");

  const analyze = await execJson(traffic, "analyze", { action: "analyze", limit: 20 });
  assert(analyze && (analyze.candidates || analyze.endpoints || analyze.summary || Object.keys(analyze).length > 0), "analyze empty");

  const repeated = await execJson(traffic, "repeat", { action: "repeat", id: added.traffic_id });
  assert(repeated.traffic_id && repeated.traffic_id !== added.traffic_id, "repeat must create new traffic id");
  assert(repeated.evidence_id, "repeat missing evidence");
  assert(String(repeated.body || "").includes("base"), `repeat body unexpected: ${repeated.body}`);

  const mutated = await execJson(traffic, "mutate", {
    action: "mutate",
    id: added.traffic_id,
    param: "q",
    value: "mutated-value",
  });
  assert(mutated.traffic_id && mutated.traffic_id !== repeated.traffic_id, "mutate must create distinct traffic id");
  assert(String(mutated.body || "").includes("mutated-value"), `mutate body unexpected: ${mutated.body}`);
  assert(mutated.evidence_id, "mutate missing evidence");

  const all = runtime.traffic.list({ limit: 50 });
  assert(all.length >= 3, `expected >=3 traffic rows, got ${all.length}`);
  const evidence = await runtime.evidence.list();
  assert(evidence.length >= 2, `expected evidence from repeat/mutate, got ${evidence.length}`);

  // Session cookie from repeat should land in snapshot jar when Set-Cookie present.
  const cookie = runtime.traffic.snapshot()?.cookie;
  assert(cookie && String(cookie).includes("SID=from-search"), `session cookie not stored: ${cookie}`);

  const coverage = await runtime.coverage.summary();
  console.log(JSON.stringify({
    ok: true,
    traffic_count: all.length,
    candidates: candidates.length,
    repeat_id: repeated.traffic_id,
    mutate_id: mutated.traffic_id,
    evidence_count: evidence.length,
    coverage_total: coverage.total,
    cookie,
    external_caido: "not required for this in-process path",
  }, null, 2));
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
