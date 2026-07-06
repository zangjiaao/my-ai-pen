import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execPath } from "node:process";
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

const workspaceDir = resolve("tmp", "node2-scan-sandbox-smoke");
const taskId = `scan-sandbox-${randomUUID()}`;
const taskDir = resolve(workspaceDir, taskId);
const binDir = resolve(taskDir, "bin");
await mkdir(binDir, { recursive: true });
const fakeDocker = resolve(binDir, "fake-docker.mjs");
await writeFile(
  fakeDocker,
  [
    "console.log('MOCK_DOCKER_ARGS:' + process.argv.slice(2).join(' '));",
    "console.log(JSON.stringify({ url: 'http://host.docker.internal:8080/login.php', status_code: 200, title: 'Login' }));",
    "",
  ].join("\n"),
  "utf8",
);

const oldDockerBin = process.env.NODE2_DOCKER_BIN;
const oldDockerArgs = process.env.NODE2_DOCKER_BIN_ARGS;
process.env.NODE2_DOCKER_BIN = execPath;
process.env.NODE2_DOCKER_BIN_ARGS = JSON.stringify([fakeDocker]);

try {
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "scan sandbox smoke",
      target: { type: "url", value: "http://localhost:8080/login.php" },
      scope: { allow: ["http://localhost:8080", "http://host.docker.internal:8080"] },
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
    trafficProxyUrl: "http://127.0.0.1:61234",
    scannerSandbox: {
      enabled: true,
      image: "strix-sandbox:smoke",
    },
  };
  runtime.plan.start();
  const scan = createScanTool(runtime);
  const result = await execJson(scan, "scan-sandbox", {
    scanner: "httpx",
    target: "http://localhost:8080/login.php",
  });
  if (result.execution?.runner !== "docker") throw new Error(`expected docker runner: ${JSON.stringify(result.execution)}`);
  const stdout = String(result.stdout || "");
  if (!stdout.includes("strix-sandbox:smoke")) throw new Error(`expected sandbox image in docker args: ${stdout}`);
  if (!stdout.includes("host.docker.internal:8080")) throw new Error(`expected target rewrite in docker args: ${stdout}`);
  if (!stdout.includes("HTTP_PROXY=http://host.docker.internal:61234")) throw new Error(`expected proxy rewrite in docker args: ${stdout}`);
  console.log(JSON.stringify({
    ok: true,
    runner: result.execution.runner,
    image: result.execution.image,
    argv: result.argv,
    evidenceEvents: sink.events.filter((event) => event.type === "evidence_created").length,
  }, null, 2));
} finally {
  restoreEnv("NODE2_DOCKER_BIN", oldDockerBin);
  restoreEnv("NODE2_DOCKER_BIN_ARGS", oldDockerArgs);
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
