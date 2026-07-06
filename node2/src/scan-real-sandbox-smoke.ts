import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createScanTool } from "./tools/scan.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const target = process.argv.includes("--target")
  ? process.argv[process.argv.indexOf("--target") + 1] || "http://localhost:8080/login.php"
  : "http://localhost:8080/login.php";
const image = process.env.NODE2_SCANNER_SANDBOX_IMAGE || process.env.STRIX_IMAGE || "ghcr.io/usestrix/strix-sandbox:1.0.0";
const workspaceDir = resolve("tmp", "node2-scan-real-sandbox-smoke");
const taskId = `scan-real-sandbox-${randomUUID()}`;
const taskDir = resolve(workspaceDir, taskId);
await mkdir(taskDir, { recursive: true });

const url = new URL(target);
const dockerTarget = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ? (() => {
      url.hostname = "host.docker.internal";
      return url.toString();
    })()
  : target;

const sink = new MemorySink();
const runtime: ToolRuntime = {
  task: {
    taskId,
    conversationId: taskId,
    instruction: "real scanner sandbox smoke",
    target: { type: "url", value: target },
    scope: { allow: [target, dockerTarget, new URL("/", dockerTarget).toString().replace(/\/$/, "")] },
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
  scannerSandbox: {
    enabled: true,
    image,
  },
};
runtime.plan.start();

const scan = createScanTool(runtime);
const result = await execJson(scan, "scan-real-httpx", {
  scanner: "httpx",
  target,
  timeout_seconds: 90,
  args: ["-sc", "-title", "-ct"],
});

if (result.execution?.runner !== "docker") throw new Error(`expected docker runner: ${JSON.stringify(result.execution)}`);
if (result.exitCode !== 0) throw new Error(`httpx sandbox scan failed: ${JSON.stringify({ stderr: result.stderr, stdout: result.stdout, execution: result.execution })}`);
if (!result.ingested || result.ingested.parsed_urls < 1 || result.ingested.traffic_ids.length < 1) {
  throw new Error(`expected ingested URL traffic: ${JSON.stringify(result.ingested)}`);
}

console.log(JSON.stringify({
  ok: true,
  runner: result.execution.runner,
  image: result.execution.image,
  target,
  argv: result.argv,
  ingested: result.ingested,
  trafficTotal: runtime.traffic.list({ limit: 20 }).length,
  candidates: runtime.traffic.candidates(10).length,
  stdout: String(result.stdout || "").slice(0, 1000),
  taskDir,
}, null, 2));

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}
