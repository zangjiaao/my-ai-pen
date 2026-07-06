import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Node2Config } from "./config.js";
import { defaultBridgePython, startCaidoBridge } from "./runtime/caido-bridge.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createTrafficTool } from "./tools/traffic.js";
import { sendHttp } from "./tools/http.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const targetServer = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/via-caido") return send(res, 200, `via-caido:${url.searchParams.get("q") || ""}:${body}`);
  return send(res, 404, "not found");
});

await listen(targetServer);
const target = serverBase(targetServer, "host.docker.internal");
const taskId = `caido-sidecar-traffic-${randomUUID()}`;
const sink = new MemorySink();
const bridge = await startCaidoBridge(smokeConfig(), sink, {
  taskId,
  conversationId: taskId,
  instruction: "caido sidecar traffic smoke",
  target: { type: "url", value: target },
  scope: { allow: [target] },
  snapshot: {},
});
if (!bridge || !bridge.caidoUrl) throw new Error("expected sidecar-backed Caido bridge");

try {
  const response = await sendHttp({
    method: "GET",
    url: `${target}/via-caido?q=needle`,
    headers: {},
    proxyUrl: bridge.caidoUrl,
  });
  if (response.status !== 200 || !response.body.includes("needle")) {
    throw new Error(`proxied request failed: ${JSON.stringify(response)}`);
  }

  const workspaceDir = resolve("tmp", "node2-caido-sidecar-traffic-smoke");
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "caido sidecar traffic smoke",
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
    trafficProxyUrl: bridge.caidoUrl,
    externalTrafficSource: bridge.source,
  };
  runtime.plan.start();
  const traffic = createTrafficTool(runtime);
  const synced = await execJson(traffic, "traffic-sync", { action: "sync", limit: 20, url_contains: "/via-caido" });
  if (synced.synced_count < 1) throw new Error(`expected Caido-captured traffic to sync: ${JSON.stringify(synced)}`);
  const candidates = await execJson(traffic, "traffic-candidates", { action: "candidates", limit: 5 });
  if (!Array.isArray(candidates) || candidates.length < 1) throw new Error("expected synced Caido traffic candidate");

  console.log(JSON.stringify({
    ok: true,
    caidoUrl: bridge.caidoUrl,
    bridgeUrl: bridge.url,
    proxiedStatus: response.status,
    syncedCount: synced.synced_count,
    trafficTotal: runtime.traffic.list({ limit: 50 }).length,
    candidateCount: candidates.length,
    sidecarEvents: sink.events.filter((event) => String(event.type).startsWith("traffic_sidecar_")).map((event) => event.type),
    bridgeEvents: sink.events.filter((event) => String(event.type).startsWith("traffic_bridge_")).map((event) => event.type),
  }, null, 2));
} finally {
  await bridge.stop();
  await close(targetServer);
}

function smokeConfig(): Node2Config {
  return {
    nodeName: "smoke",
    nodeToken: "",
    platformWsUrl: "",
    workspaceDir: resolve("tmp", "node2-caido-sidecar-traffic-smoke"),
    piAgentDir: resolve(".pi-agent"),
    pentestSkillsDir: resolve("skills"),
    pentestWorkflowsDir: resolve("workflows"),
    pocCatalogPath: resolve("poc-catalog", "web-vulns.json"),
    piWorkflowPackageDir: resolve("node_modules", "@agwab", "pi-workflow"),
    modelProvider: "openai",
    modelId: "gpt-5",
    caidoBridgeAutoStart: true,
    caidoBridgeHost: "127.0.0.1",
    caidoBridgePort: undefined,
    caidoBridgePython: defaultBridgePython(),
    caidoBridgeScript: resolve("bridges", "caido_traffic_bridge.py"),
    caidoSidecarAutoStart: true,
    caidoSidecarImage: process.env.NODE2_CAIDO_SIDECAR_IMAGE || "ghcr.io/usestrix/strix-sandbox:1.0.0",
    caidoSidecarHost: "127.0.0.1",
    caidoSidecarPort: undefined,
    caidoUrl: process.env.STRIX_CAIDO_URL,
    scannerSandboxAutoStart: false,
    scannerSandboxImage: "ghcr.io/usestrix/strix-sandbox:1.0.0",
  };
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveListen) => server.listen(0, "0.0.0.0", resolveListen));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function serverBase(server: ReturnType<typeof createServer>, host: string): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return `http://${host}:${address.port}`;
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
