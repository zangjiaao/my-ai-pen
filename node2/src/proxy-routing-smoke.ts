import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createHttpTool } from "./tools/http.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const targetServer = createServer(async (req, res) => {
  send(res, 200, `target:${req.method}:${req.url || "/"}`);
});
await listen(targetServer);
const targetAddress = targetServer.address();
if (!targetAddress || typeof targetAddress === "string") throw new Error("target server did not bind");
const target = `http://127.0.0.1:${targetAddress.port}`;

const proxiedRequests: string[] = [];
const proxyServer = createServer(async (clientReq, clientRes) => {
  const fullUrl = String(clientReq.url || "");
  proxiedRequests.push(fullUrl);
  const upstream = new URL(fullUrl);
  const body = await readBody(clientReq);
  const upstreamReq = httpRequest(
    upstream,
    {
      method: clientReq.method,
      headers: { ...clientReq.headers, host: upstream.host },
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );
  upstreamReq.on("error", (error) => send(clientRes, 502, String(error.message || error)));
  if (body) upstreamReq.write(body);
  upstreamReq.end();
});
await listen(proxyServer);
const proxyAddress = proxyServer.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy server did not bind");
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

try {
  const workspaceDir = resolve("tmp", "node2-proxy-routing-smoke");
  const taskId = `proxy-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "proxy routing smoke",
      target: { type: "url", value: target },
      scope: { allow: [target] },
      snapshot: {},
    },
    workspaceDir,
    platform: new MemorySink(),
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
    trafficProxyUrl: proxyUrl,
  };
  runtime.plan.start();
  const http = createHttpTool(runtime);
  const result = await execJson(http, "proxy-http", { method: "GET", url: `${target}/through-proxy?x=1` });
  if (!String(result.body || "").includes("/through-proxy?x=1")) throw new Error(`unexpected target response: ${JSON.stringify(result)}`);
  if (!proxiedRequests.some((item) => item === `${target}/through-proxy?x=1`)) {
    throw new Error(`request did not route through proxy: ${JSON.stringify(proxiedRequests)}`);
  }
  console.log(JSON.stringify({ ok: true, proxyUrl, proxiedRequests, trafficTotal: runtime.traffic.list({ limit: 10 }).length }, null, 2));
} finally {
  await close(proxyServer);
  await close(targetServer);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
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

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}
