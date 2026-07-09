import { existsSync } from "node:fs";
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
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const port = 48180 + Math.floor(Math.random() * 1000);
const python = defaultBridgePython();
const sink = new MemorySink();
const taskId = `caido-bridge-${randomUUID()}`;
const config = smokeConfig(port, python, process.argv.includes("--sidecar"));
const task = {
  taskId,
  conversationId: taskId,
  instruction: "caido bridge status smoke",
  target: { type: "url", value: "http://127.0.0.1" },
  scope: { allow: ["http://127.0.0.1"] },
  snapshot: {},
};
const bridge = await startCaidoBridge(config, sink, task);
if (!bridge) throw new Error("expected auto-started Caido bridge");

try {
  const workspaceDir = resolve("tmp", "node2-caido-bridge-status-smoke");
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const runtime: ToolRuntime = {
    task,
    workspaceDir,
    platform: sink,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
    externalTrafficSource: bridge.source,
  };
  runtime.plan.start();
  const traffic = createTrafficTool(runtime);
  const status = await execJson(traffic, "source-status", { action: "source_status" });
  if (!status.configured || !status.reachable || status.upstream?.bridge !== "node2-caido-traffic") {
    throw new Error(`unexpected bridge status: ${JSON.stringify(status)}`);
  }
  if (existsSync(resolve("..", "research", "strix", ".venv")) && status.upstream?.strix_imported !== true) {
    throw new Error(`bridge did not import Strix Caido SDK with ${python}: ${JSON.stringify(status)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    python,
    caidoUrl: bridge.caidoUrl,
    status,
    lifecycleEvents: sink.events.filter((event) => String(event.type).startsWith("traffic_bridge_")).map((event) => event.type),
    sidecarEvents: sink.events.filter((event) => String(event.type).startsWith("traffic_sidecar_")).map((event) => event.type),
  }, null, 2));
} finally {
  await bridge.stop();
}

function smokeConfig(port: number, python: string, sidecar: boolean): Node2Config {
  return {
    nodeName: "smoke",
    nodeToken: "",
    platformWsUrl: "",
    workspaceDir: resolve("tmp", "node2-caido-bridge-status-smoke"),
    piAgentDir: resolve(".pi-agent"),
    pentestSkillsDir: resolve("skills"),
    pentestWorkflowsDir: resolve("workflows"),
    pocCatalogPath: resolve("poc-catalog", "web-vulns.json"),
    piWorkflowPackageDir: resolve("node_modules", "@agwab", "pi-workflow"),
    modelProvider: "openai",
    modelId: "gpt-5",
    caidoBridgeAutoStart: true,
    caidoBridgeHost: "127.0.0.1",
    caidoBridgePort: port,
    caidoBridgePython: python,
    caidoBridgeScript: resolve("bridges", "caido_traffic_bridge.py"),
    caidoSidecarAutoStart: sidecar,
    caidoSidecarImage: process.env.NODE2_CAIDO_SIDECAR_IMAGE || "ghcr.io/usestrix/strix-sandbox:1.0.0",
    caidoSidecarHost: "127.0.0.1",
    caidoSidecarPort: undefined,
    caidoUrl: process.env.STRIX_CAIDO_URL,
    llmCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    scannerSandboxAutoStart: false,
    scannerSandboxImage: "ghcr.io/usestrix/strix-sandbox:1.0.0",
  };
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}
